# 通用 AI 记忆产品 consolidation 调研材料

调研日期：**2026-10-15**。目标：为 pi-scoped-memory 的「跨项目重复条目 → 判定可泛化 → 生成全局条目 → 处置项目条目」提供机制证据；不是基础存储选型。下文分别标注**源码事实、产品声明、用户报告、研究者推断、对本项目的建议**，不把 issue 建议写成已实现功能。

## 0. 取证方法、版本锚点与边界

- 已读取 `/Users/jason/.agents/skills/web-search/SKILL.md`。该安装目录只有技能说明，缺少 `scripts/search.sh`；找到 LobsterAI 实际脚本后调用搜索，返回 `Failed to auto-start Bridge Server`；再尝试其 `start-server.sh`，返回 `Failed to compile TypeScript server`。因此**专用搜索不可用**，网页部分降级用可用网页搜索/抓取工具；不是靠已有知识补写。
- 开源部分全部优先 GitHub 一手源：`git clone --depth 1 --filter=blob:none` 到 `/tmp/memory-products-research/`，配合 `gh api repos/.../contents/... -H 'Accept: application/vnd.github.raw'` 或内容字段解码；issue 用 `gh api repos/.../issues/...` 读取原文。没有修改目标项目源码。
- 源码快照：mem0 `0724291bd864cf807e88ee8981c8226644e8fb42`；经典机制另读 tag `v1.0.0`（`394203d1b5f56385d28690ea27c0d746007ff940`）；Letta 入口仓库 `5bcdd177d70fa2b31a754cfcd801e77b2e1ab16a`、archive 分支 `56ba9c25552605eec89de8ed3dc6394b625c1993`、当前 letta-code `cc4654acc3b424a68c385bce0fe0c00edaad5d7e`；Graphiti `aca369364226a666ca541b061ff2a1a54b80f2ff`；LangMem `48e3c11f5bb527282c7d5339c6a87a0b35abccfc`；Memobase `358c16bbc6d687937d79bc2f984a11c3be8da901`；memU `bbf2d7040d00c0b5b41b72505085a1349d9b9af6`。
- GitHub 文件链接部分使用上述固定 SHA/固定 tag；issue 的 open/closed 是本次查询状态，**closed 不等于已修复**。未运行这些产品的模型、数据库或回归测试；问题结论区分源码可见风险与报告者实测。

## 1. mem0：必须区分经典四操作与当前 ADD-only

### 机制与触发时机

**经典 v1.0.0，调用 `Memory.add(..., infer=True)` 时同步处理**：先 LLM 提取事实，再对每条事实检索相关旧记忆，再由第二次 LLM 调用给出 `ADD / UPDATE / DELETE / NONE`。用户任务中的 NOOP，在源码中的枚举名是 **NONE**。`infer=False` 直接创建原始消息记忆，不走合并判定。

- 来源：[v1.0.0 main.py](https://github.com/mem0ai/mem0/blob/v1.0.0/mem0/memory/main.py)，`_add_to_vector_store`（约 386 行起）、`add`（约 281 行起）。关键原文：`limit=5`；注释 `mapping UUIDs with integers for handling UUID hallucinations`。取舍：检索只负责召回候选，整数映射降低模型编造 UUID 的机会。**适配判断**：适合复用「候选集内稳定短 ID + LLM 输出操作计划」；不要让模型直接随意写路径、删除任意文件。
- 来源：[v1.0.0 configs/prompts.py](https://github.com/mem0ai/mem0/blob/v1.0.0/mem0/configs/prompts.py)，`DEFAULT_UPDATE_MEMORY_PROMPT`（175 行起）、`get_update_memory_messages`（405 行起）。关键原文：`keep the fact which has the most information`；`NONE: Make no change`。prompt 规定新内容新增、信息更丰富则更新、矛盾或要求删除则删除、重复或无关则 NONE；调用方可传 `custom_update_memory_prompt`。取舍：UPDATE 与 DELETE 的语义有重叠，最终依赖 prompt 和模型，不是确定性冲突规则。**适配判断**：借鉴显式操作枚举，但把「重复」「可泛化」「同主题但不等价」「冲突」拆开，避免直接抄这个宽泛判据。

### 新记忆决策流程（经典源码的概括伪代码）

```text
add(messages, scope, infer=True):
  facts = LLM(fact_extraction_prompt, messages)
  old = union_by_id(vector_search(fact, scope, top_k=5) for fact in facts)
  short_id_map = map_uuid_to_integer(old)
  plan = LLM(update_memory_prompt, facts, old_with_short_ids)
  for action in plan:
    ADD    -> create(new_uuid, text)
    UPDATE -> update(short_id_map[id], text), retain mutation history
    DELETE -> delete(short_id_map[id]), record history
    NONE   -> no text mutation
              # 特定情况下仍补充 agent_id/run_id，并非所有字段都不动
```

**相似阈值核对**：上述写入合并检索只传 `limit=5` 与 scope filter，**没有 similarity threshold 参数或本地 score 截断**。`search()` 对外接口的 threshold 与写入 consolidation 不是同一入口，不能把它当自动合并阈值。[同一 main.py 的 `_search_vector_store` 另行检查 score](https://github.com/mem0ai/mem0/blob/v1.0.0/mem0/memory/main.py#L946)。取舍：不设阈值保证模型至少看到一些旧事实，但候选可能不相关；top-k 又可能漏掉真正冲突。**适配判断**：本项目可用无模型候选召回，但真正删除/晋升必须看原文、项目范围与语义等价，不能用一个向量分数充当泛化证据。

### 当前 main 的重要变化

- 来源：[当前 main.py 固定快照](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py#L881)，`_add_to_vector_store` 的 `V3 PHASED BATCH PIPELINE`：取最近消息 `limit=10`，用整段新消息检索 `top_k=10`，**单次 LLM additive extraction**，批量 embedding，再对召回候选 hash 与当前批 hash 去重，批量插入并记录 ADD。没有沿用旧四操作执行循环。
- 来源：[当前 prompts.py](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/configs/prompts.py#L468)，`ADDITIVE_EXTRACTION_PROMPT`。关键原文：`Your sole operation is ADD`。旧 `DEFAULT_UPDATE_MEMORY_PROMPT` 还在文件中，**存在不代表当前 add 热路径调用它**；prompt 虽允许 `linked_memory_ids` 表达更新/矛盾关联，不能据此推断旧条目会被覆盖或失效。取舍：降低调用复杂度，但历史状态一致性移向检索或后续处理。**适配判断**：不要用当前 mem0 的品牌介绍证明“自动消解冲突”；本项目需要明确实现写全局后的源条目处置，ADD-only 不够。

### Procedural memory

- 来源：[当前 `_create_procedural_memory`](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py#L2007)、[prompt](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/configs/prompts.py#L326)。显式提供 `agent_id` 与 `memory_type='procedural_memory'` 后，把对话交给 `PROCEDURAL_MEMORY_SYSTEM_PROMPT` 生成程序性总结，然后 embedding、`_create_memory`，结果仍为 ADD；不是自动聚类旧经验、也不是直接改 agent 的系统规则。
- 取舍：能把对话蒸馏成工作方式，但该分支本身没有旧 procedural memory 的 consolidation。**适配判断**：可借鉴独立的流程类 prompt；不应把“有 procedural 类型”误读为“跨项目规律自动升级成全局规则”。

### Graph memory（历史实现，不冒充当前 main 能力）

- 来源：[v1.0.0 graph_memory.py](https://github.com/mem0ai/mem0/blob/v1.0.0/mem0/memory/graph_memory.py)，`add`、`_get_delete_entities_from_search_output`、`_delete_entities`、`_add_entities`；[graphs/utils.py](https://github.com/mem0ai/mem0/blob/v1.0.0/mem0/graphs/utils.py) 的关系提取/删除 prompt。流程：提取实体 → 提取关系 → 搜索旧图关系 → LLM 用 `delete_graph_memory` 工具判定删哪些关系 → 删旧关系 → 加新关系。向量与图在 `add` 内并行执行，不是同一个原子事务。
- 实际阈值：图上下文检索 `self.threshold = 0.7`；复用 source/destination 实体的查找默认 `threshold=0.9`。这是**图实体/关系相关检索阈值**，不是向量记忆自动合并阈值；旧关系物理删除，不是 Graphiti 式双时间失效记录。
- 当前快照未包含 `mem0/memory/graph_memory.py` 或 `mem0/graphs/` 的该实现，`main.py` 亦未发现原图写入路径。取舍：旧机制是关系替换而非有溯源的长期历史。**适配判断**：只借鉴“召回旧关系后再作冲突裁决”，不要为 Markdown 双层插件引入完整图数据库。

### 已知问题与反面证据

- [#5867](https://github.com/mem0ai/mem0/issues/5867)，2026-06-25，open。原文标题：`ADD-only memory extraction can create conflicting memories`。报告 Ronaldo→Messi 偏好变化后两条同时保留；与当前 ADD-only 路径一致。**取舍/适配**：不能把“写入成功”视为 consolidation 成功；测试应验证源条目是否仍会与全局重复注入。
- [#6515](https://github.com/mem0ai/mem0/issues/6515)，open。关键原文：`both pass dedup against the same (not-yet-updated) state`。报告 hash 去重使用 LLM 前快照，并发相同事实可插入两份。源码可见去重与插入之间没有该作用域的重新校验。**取舍/适配**：跨层写入必须锁住提交段并校验输入 hash；模型思考时间不能算在“已锁定旧状态”里。
- [#7612](https://github.com/mem0ai/mem0/issues/7612)，open，标题指出过期记忆会阻止相同事实的重新推断写入。仅作报告线索，本次未复现。**取舍/适配**：去重应分清 active、superseded、deleted，不然软删除会阻止合法的新版本。

**本产品可借鉴一句话**：抄经典「召回→结构化四操作→确定性执行」的接口形态，不抄当前 ADD-only 对冲突与原条目的放任。

## 2. Letta / MemGPT：sleep-time 与当前 Markdown reflection 最贴近本项目

### 版本边界

[letta-ai/letta README](https://github.com/letta-ai/letta/blob/5bcdd177d70fa2b31a754cfcd801e77b2e1ab16a/README.md) 明确当前源码在 `letta-ai/letta-code`，V1 API server 退役源码在 `archive` 分支。下文先描述历史 memory tools，再给**当前活跃实现**，避免把两代架构混用。

### 历史 self-editing tools：判定者就是 agent

- 来源：[archive function_sets/base.py](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/functions/function_sets/base.py#L311)。`memory_replace(label, old_string, new_string)` 要求旧串精确、唯一匹配；零次或多次出现都报错。`memory_insert` 按行插入；`memory_rethink(label, new_memory)`（488 行起）整体重写块。此快照实际整块重写工具名是 **memory_rethink / rethink_memory**，未找到名为 `memory_rewrite` 的函数，不把概念名冒充 API 名。
- 核心事实：不是新事实到来便固定跑 ADD/UPDATE 分类器，而是前台/后台 agent 读当前 block，决定调用窄编辑还是整块重组工具。块与大小约束在 memory schema 层；没有统一语义相似阈值。
- 取舍：工具提供受控执行能力，语义策略交给 agent。**适配判断**：本项目宜让 LLM 只返回可审计的变更计划；精确旧内容匹配/版本检查由代码承担。

### 历史 sleep-time：后台 agent 维护共享核心记忆

- 来源：[sleeptime_v2.py](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/prompts/system_prompts/sleeptime_v2.py)。关键原文：`do not contain redundant and outdate information`。prompt 指导后台 agent 做窄修改或 rethink，直到块有组织、可读、不过时；无有意义更新可直接 finish；日期必须绝对化。
- 来源：[sleeptime_multi_agent_v4.py](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/groups/sleeptime_multi_agent_v4.py#L132)。前台完成响应后，可按 `sleeptime_agent_frequency` 的轮次计数触发；无响应跳过；截取自上次处理点后的对话，创建 Run，用 `safe_create_task` 调后台 agent。后台消息强调它不是前台对话参与者，使用 memory tools 更新相关 block。**不是操作系统空闲检测，也不是固定每天夜间执行**。
- 取舍：把维护成本移出回答热路径，仍需处理失败、并发与进度标记。**适配判断**：最适合本项目的不是自动提取本身，而是“前台写一事一文件，后台集中审阅多个项目的既有文件”。

### 当前 letta-code：完整的离线提案→合入模型

1. **触发时机**：来源 [memory-reminder.ts](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/cli/helpers/memory-reminder.ts)、[post-turn-reflection.ts](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/cli/helpers/post-turn-reflection.ts)。默认 `trigger='compaction-event'`、`merge='auto'`；可设 `off`、`step-count`，默认步数参数 25，仅在启用 step-count 时用；在轮末、transcript delta 已追加后评估。**适配判断**：借鉴去抖/轮末批处理，不需要绑定每次 memory_write 都启动模型。
2. **判定者/prompt**：来源 [builtin/reflection-v2.md](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/agent/subagents/builtin/reflection-v2.md)、[reflection-prompt.ts](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/cli/helpers/reflection-prompt.ts)。关键原文：`Distill reusable patterns, not event transcripts`。背景 agent 可以读多 transcript manifest，**replay 已处理片段也用于去重、冲突与跨会话模式提取**；先查看现存记忆，再筛持久性/已覆盖/可泛化/日期，修订旧事实源头，不并列追加矛盾版本。**适配判断**：最值得抄的是“跨多输入找模式 + 先查已有归宿 + 修改旧文件优先”，而非一个对每次对话独立运行的提取器。
3. **分层与重组**：同一 v2 prompt 定义根 `MEMORY.md` 以及子目录 `MEMORY.md` 索引；根其他 Markdown 为 core，子目录为 deferred；要求移动/删除后修复索引与链接。允许退役上下文进 `ARCHIVE.md`，用户要求忘记/敏感/错误内容直接删。**适配判断**：层次是 core/deferred、不是 global/project，但「移动后维护索引」「归档与忘记分开」可直接借鉴。
4. **提交隔离**：来源 [memory-worktree.ts](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/agent/memory-worktree.ts)、[reflection-integration.ts](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/cli/helpers/reflection-integration.ts)。后台在私有 Git worktree 产生 commit，auto 模式合入；`explicit` 不是必然找用户审批，而是另开 primary-agent integration conversation 审核并自主合入。父仓库 dirty 时停止，不 stash/丢弃用户改动；merge 冲突时 abort、清理提案，保留可重试语义。**适配判断**：可做更轻的 staged plan + 文件 hash/CAS + journal，不必照搬一个完整 Git worktree；但不能让模型在共享 Markdown 上直接边想边删。

### 新内容进入后的当前流程（概括伪代码）

```text
on_turn_end:
  append_transcript_delta()
  if memfs_enabled and configured_trigger_fires:
    payload = pending_transcripts + selected_replay_transcripts
    proposal = reflection_agent(private_worktree, payload, current_memory)
      inspect_existing_files_and_indexes()
      select_durable_learnings()
      update_existing / create / move_tier / archive / delete / no_op
      repair_indexes_and_links()
      commit_if_changed()
    if merge_mode == explicit:
      primary_agent_review_and_merge_in_separate_conversation(proposal)
    else:
      merge(proposal)
    if integration_succeeded:
      advance_reflection_progress()
    else:
      keep_source_payload_retryable()
```

来源还包括 [reflection-completion.ts](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/cli/helpers/reflection-completion.ts)、[reflection-transcript.ts](https://github.com/letta-ai/letta-code/blob/cc4654acc3b424a68c385bce0fe0c00edaad5d7e/src/cli/helpers/reflection-transcript.ts)。这是**后台语义 consolidation + 并发安全 integration**，不是向量阈值去重。

### Archival memory 重组的证据边界与已知问题

- [archive archival_memory_insert/search](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/functions/function_sets/base.py#L164) 提供长期 passage 插入与检索；不能由此推出 passage 自动聚类合并。
- [#3116](https://github.com/letta-ai/letta/issues/3116) 请求 archival 去重/合并，举多个同义颜色偏好 passage 的例子。虽 closed，维护者建议的是先用 custom tools + archival API/SDK 原型化，并不是已实现通用自动 consolidation；后续大量评论含外部推广，不作为实现证据。**适配判断**：core 的 self-editing 很强，不代表 archival 已自动清理，需明确功能边界。
- [#3109](https://github.com/letta-ai/letta/issues/3109) 报告 Docker 0.15.1 下 sleep-time 未运行，错误涉及模型 SDK 非流式请求约束；closed，未在本次证明解决方式。当前 worktree 源码另显式处理 `parent_dirty`、`merge_conflict`、integration failure。**适配判断**：后台任务必须可见状态、可重试，不能只展示“已整理”而没有确实提交/整合证据。

**本产品可借鉴一句话**：优先借鉴当前 reflection 的「跨会话蒸馏 + Markdown 索引完整性 + 隔离提案 + 成功合入才推进进度」。

## 3. Zep / Graphiti：事实失效不等于删除，community 不等于全局泛化

### 机制、触发与判定者

- 来源：[Graphiti.add_episode](https://github.com/getzep/graphiti/blob/aca369364226a666ca541b061ff2a1a54b80f2ff/graphiti_core/graphiti.py#L1341)。每次 ingestion 提取实体/关系，实体去重解析，再对 edge 做去重、时间提取与失效；方法建议后台队列执行且 episode 顺序 await。`update_communities=False` 是实际默认值，**community 不会默认每次自动重建**。取舍：增量图维护，不是必须全量重新总结。**适配判断**：把泛化任务设计为显式/配置触发，避免暗中让每次读写都改全局。
- 来源：[edge_operations.py](https://github.com/getzep/graphiti/blob/aca369364226a666ca541b061ff2a1a54b80f2ff/graphiti_core/utils/maintenance/edge_operations.py)，`resolve_extracted_edges`、`_dedupe_extracted_edge`、`resolve_edge_contradictions`。先用实体对约束的候选判断 duplicate，再用更宽的 hybrid search 召回 invalidation candidates；LLM 返回 `duplicate_facts`、`contradicted_facts`，代码检查索引后执行。重复 edge 复用并附加 episode 来源，而非盲目新增。
- 来源：[dedupe_edges.py prompt](https://github.com/getzep/graphiti/blob/aca369364226a666ca541b061ff2a1a54b80f2ff/graphiti_core/prompts/dedupe_edges.py)。关键原文：`Do NOT infer contradiction from recency alone`；`cannot both be true`。数字、日期、限定语不同不能轻易当 duplicate；项目进展/新活动也不能轻易否定职责/所有权。**适配判断**：对我们尤其重要——两个项目都出现相近规则不意味着同一适用域，较新项目条目也不自动覆盖全局规则。

### 双时间事实与 edge invalidation

- 来源：[edges.py 的 EntityEdge](https://github.com/getzep/graphiti/blob/aca369364226a666ca541b061ff2a1a54b80f2ff/graphiti_core/edges.py#L252)。`valid_at/invalid_at` 表示事实在现实/episode 时间中的有效区间；`created_at/expired_at` 表示系统何时记录/作废认知，另有 `episodes` 回溯证据。
- `resolve_edge_contradictions` 先检查区间是否重叠；不重叠可以同时作为历史保留；旧事实早于新事实时，把旧 edge `invalid_at` 置为新 edge `valid_at`，`expired_at` 置为当前系统时间。乱序到来的旧事实也可能一写入就标为失效，不能简单“后写者赢”。**这不是物理删除旧 edge**。
- 取舍：保留历史与事实来源，但 query 必须正确筛 active/历史区间。**适配判断**：晋升后项目原条目宜保留 `superseded_by/global_ref` 式出处指针或审计记录，active 索引停止重复注入；删除、失效、抽象提炼是三个不同动作。

### 新 episode 的流程（概括伪代码）

```text
add_episode(episode, reference_time):
  entities = extract_and_resolve_entities(episode, recent_episodes)
  proposed_edges = extract_edges(episode, entities)
  for edge in proposed_edges:
    duplicates = hybrid_search_with_entity_pair_scope(edge)
    potential_conflicts = broader_hybrid_search(edge, group_id)
    judgment = LLM(dedupe_edges.resolve_edge, edge, duplicates, potential_conflicts)
    canonical_edge = reuse_duplicate_or_keep_new(judgment)
    attach_episode_provenance(canonical_edge)
    extract_temporal_bounds_if_needed(canonical_edge)
    invalidate_only_conflicting_time_overlaps(judgment)
  persist_episode_entities_edges_including_invalidated_edges()
  if update_communities: update_affected_community_summaries()
```

### Episode → entity/edge → community 层次

- 来源：[community_operations.py](https://github.com/getzep/graphiti/blob/aca369364226a666ca541b061ff2a1a54b80f2ff/graphiti_core/utils/maintenance/community_operations.py)。`get_community_clusters` 用 label propagation 按实体图连接聚类；`build_community` 将实体 summaries 两两 LLM 总结归约，建立 community 节点和 membership edges；`update_community` 做增量摘要维护；[Graphiti.build_communities](https://github.com/getzep/graphiti/blob/aca369364226a666ca541b061ff2a1a54b80f2ff/graphiti_core/graphiti.py#L1850) 可显式调用。
- 核心事实：episode 是来源层，entity/relationship 是事实层，community 是聚合摘要/检索层；不是“直接将原 episode 替换成更抽象文本”，也没有证据说明它会跨租户/group_id 抽取通用偏好。**适配判断**：可以借鉴“总结派生层仍保留证据层”，不应把 community 作为我们跨项目晋升的现成算法。

### 已知问题

- [#1728](https://github.com/getzep/graphiti/issues/1728)，open。标题：`Edge invalidation searches the whole graph, so unrelated facts retire each other`。报告候选范围过宽、小模型误判导致无关事实被标失效；当前源码的 invalidation 搜索仍可见 `SearchFilters()`，与 duplicate 的实体对范围不同。不是本次复现实测。**取舍/适配**：危险操作前要先作结构性范围保护，不能只加一句“不要误删”的 prompt。
- [#1956](https://github.com/getzep/graphiti/issues/1956)，open。报告有限 top-k 被已失效历史占满，当前有效事实不进候选，LLM 无法失效它。**取舍/适配**：候选召回不足会被误判为“没有冲突”；全局目标条目必须单独读入，不要全靠相似检索排名。
- [#1666](https://github.com/getzep/graphiti/issues/1666)，open。报告非 reasoning 小模型的矛盾检测不可靠；本次未验证其模型对照数字。**取舍/适配**：不要未经评测就用最便宜模型自动进行破坏性处置。

**本产品可借鉴一句话**：借鉴“语义判断之后仍由时间/范围规则约束执行，派生摘要带证据链”，不抄全套图架构。

## 4. LangMem：独立 memory transformer + 可配置多阶段 consolidation

### 机制与分型

- 来源：[conceptual_guide.md](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/docs/docs/concepts/conceptual_guide.md)。定义 semantic（事实/知识，profile 或 collection）、episodic（成功经历/上下文例子，collection）、procedural（行为规则，prompt 或 collection）。`create_memory_manager` 是输入对话+已有状态→输出新状态的核心；`create_memory_store_manager` 才加搜索/写存储。取舍：把“怎么想”与“怎么落盘”分开。**适配判断**：非常适合现有 Markdown 插件——consolidator 是可选模型能力，不必改 v1 存储接口、强制 embedding 或数据库。
- 来源：[knowledge/extraction.py](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/knowledge/extraction.py#L185)，`_MEMORY_INSTRUCTIONS` 与 `MemoryManager`。关键原文：`Consolidate and compress redundant memories`；`What generalizations can you make?`。prompt 要求比较旧记忆、压缩冗余、删除错误，综合归纳并限定不确定性；通过 trustcall 的结构化提取/patch/delete 机制循环到 Done/max_steps。它不是固定的 ADD/UPDATE/DELETE/NONE 分类 prompt。

### 触发时机与 background/reflection

- 来源：[delayed_processing.md](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/docs/docs/guides/delayed_processing.md)、[reflection.py](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/reflection.py)。应用调用 `ReflectionExecutor.submit(payload, after_seconds=...)`；本地以线程/队列延后，相同 thread 的新请求取消尚未处理的旧请求；远程用 LangGraph run，`multitask_strategy='rollback'`。文档明确本地线程不适合 serverless。
- **源码边界**：取消任务不是自动把旧 payload 合并进新 payload；调用者必须传完整待处理上下文/聚合历史。取舍：减少碎片化提取与成本，但不意味着自动保证没有漏消息。**适配判断**：去抖队列按“待整理文件集合”积累，而不是最新文件覆盖旧任务；未提交成功不能消费旧候选。

### 新内容进入的更新策略/伪代码

```text
submit(current_or_accumulated_conversation, after_seconds):
  debounce_pending_work_by_thread()
  old = search_relevant_memories(namespace, query_limit=5)
  proposed = memory_manager(LLM, messages, existing=old)
  for extra_phase in configured_phases:
    proposed = phase_manager(existing=proposed,
                             messages=messages if include_messages else [])
  diff = compare_by_id_and_structured_content(old, proposed)
  put_only_new_or_changed(diff)
  delete_only_explicit_remove_ids(diff)  # 受 enable_deletes 限制
```

- 来源：[同一 extraction.py 的 MemoryStoreManager](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/knowledge/extraction.py#L827)。`phases` 可配置额外阶段，`include_messages=False` 时仅在已有+本次生成记忆上再次 consolidation。实际公共工厂 `create_memory_store_manager` 的 `enable_deletes=False`，`query_limit=5`；参数说明却写 deletes 默认 True，不能相信 docstring 超过函数签名。没有统一的 semantic similarity 自动合并阈值。**适配判断**：可做“提议泛化→独立验证保留例外”两阶段，默认禁止原条目物理删除。
- Procedural 来源：[prompts/optimization.py](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/prompts/optimization.py)、[概念指南 procedural 部分](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/docs/docs/concepts/conceptual_guide.md#procedural-memory-system-instructions)。`create_prompt_optimizer` 另用 trajectory/反馈改系统行为规则，不是存个 memory_type 字段就会自动生效。**适配判断**：稳定跨项目约定与可执行技能可分流，别把一次成功操作泛化为永久全局 instruction。

### 已知问题

- [#196](https://github.com/langchain-ai/langmem/issues/196)，open：`MemoryStoreManager.invoke() reports success when store writes or deletes fail`。源码同步持久化提交 future 却不读 `.result()`，异常可被隐藏；异步 gather 路径不同。报告含可控 fake store 重现，本次只做源码核对。**适配判断**：不能用“LLM 生成 plan / 函数返回”表示提交成功；必须验证全局正文、两层索引、源处置均完成。
- [#192](https://github.com/langchain-ai/langmem/issues/192)，open：指出 deletes 默认参数与 docstring 不符；源码可确认。**适配判断**：删除策略做显式配置并测试，不靠文档默认。
- [#194](https://github.com/langchain-ai/langmem/issues/194)，open：报告 ReflectionExecutor 的 store 注入/运行时兼容问题。**适配判断**：后台执行器不是免费安全层，模型之外的依赖/状态传递也要监测。

**本产品可借鉴一句话**：把 consolidation 做成可插拔、无副作用的“旧状态+证据→候选新状态”，再由本项目确定性 diff/提交。

## 5. OpenAI ChatGPT memory：双轨是历史基础，当前已有 Dreaming V3 官方说明

### 官方证据：从 saved memories + chat history 到持续 synthesis

- 来源：[OpenAI Dreaming，2026-06-04](https://openai.com/index/chatgpt-memory-dreaming/)。关键原文：`Saved memories were only written during the conversation`；`synthesize ChatGPT’s memory state`。官方给出演进：2024 saved memories → 2025 saved memories + Dreaming V0 → 2026 Dreaming V3。后台从多次对话合成状态，并随时间修正过时记忆；并非只有用户说“记住”才更新。该文章没有公开 cron 周期、去重阈值、模型名、内部 prompt 或算法源码。
- 来源：[当前 Memory FAQ](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)。关键原文：`Saved memories are stored separately from chat history`；`Improved Memory continually updates a broader summary of relevant context`。saved memories 是独立可管理条目；chat-history 派生信息会变化。新版 summary 是高层视图，不是全部记忆/全部来源，部分账号仍可切回 legacy saved memories。**适配判断**：不把“用户可见 MEMORY.md 索引”误认为全部后台证据；本项目应反而坚持可审计全部来源，避免黑箱。

### 逆向分析：能支持合并现象，不能证明后端算法

1. 来源：[Elias Bachaalany 的原始分析及截图](https://github.com/0xeb/TheBigPromptLibrary/blob/main/Articles/chatgpt-bio-tool-and-memory/chatgpt-bio-and-memory.md)，已用 gh raw 读取。关键原文：`memories are summarized and combined together as applicable`。其 2024 观察：两次写喜欢狗、喜欢猫，最后呈现一条同时喜欢狗和猫的记忆；展示 `bio` tool 和 Model Set Context 注入。**取舍**：这是实测界面/模型输出的历史观察，不是后端源代码、也不保证当前所有模型一致。**适配判断**：可借鉴“同维度偏好合并为一个规范条目”，但不能据此指定 OpenAI 用了什么向量阈值。
2. 来源：[Johann Rehberger，2025-05-04 原始研究](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)。关键原文：`It's unclear how often these entries are updated and modified`。研究者对两个账号探测，看到 saved memories 之外的响应偏好、长期主题、用户洞察与近期对话等上下文段，推测周期性带外合成；正文同时指出 system prompt dump 可能幻觉。**取舍**：说明可泛化用户画像与近期事件分层的可能形态，不能把其推测当当前已验证实现。**适配判断**：本项目需保存“由哪些原条目支持”的真实 provenance，不要把模型自称的 confidence 当事实。
3. 来源：[Simon Willison，2025-05-21 的独立使用记录](https://simonwillison.net/2025/May/21/chatgpt-new-memory/)。关键原文：`We’re losing control of the context`。他记录历史地理位置被意外带入图片生成和研究任务；文中亦于 **2025-08-22** 更新，说明 OpenAI 已推出 Project-only memory，不能把早期缺少项目隔离的批评写成当前仍完全没有隔离。分析引用 Johann，但本材料将其作为独立负面使用经验，而非内部算法证据。**适配判断**：跨项目泛化本质上扩大影响半径，必须可关闭、可预览、可回滚；项目特有内容不应因为出现多次就进全局。

### 决策流程（明确是产品行为抽象，非泄露源码）

```text
historical_saved_memory_path:
  conversation + explicit_or_salient_information
    -> model writes/updates remembered items
    -> combine_related_items_when_applicable  # 历史观察，内部判据未知

history/dreaming_path:
  multiple_conversations + prior_memory + temporal_context
    -> background synthesis
    -> refresh_relevant_preferences_and_context
    -> expose_partial_memory_summary_and_correction_controls
    -> use_relevant_context_in_future_conversations
```

**判定者/prompt/关键文件**：闭源；没有可核验的当前后端 prompt/源文件。能引用的只有官方行为说明、历史 `bio` prompt 捕获及研究者观察。固定重复次数触发、跨项目提升规则、ADD/UPDATE/DELETE 的内部 schema 均**查不到**。

### 已知问题与取舍

- 官方 Dreaming 文章承认旧 saved memories 会 stale，随时间错误/失去相关性；新版目标正是 freshness/correctness/scalability。这是官方承认的限制，不是保证新版本零误差。
- 当前 FAQ 说明：删原聊天不必然删除独立 saved memory；删 summary/停止提及不等于删除来源；残留历史可能在重新开启后再产生记忆。**适配判断**：晋升后处置源文件要和“忘记”分开；用户删除全局规则时应避免从残留项目副本自动复活。
- Rehberger 的研究还指出 memory poisoning/indirect prompt injection 风险；其旧版攻击是否仍有效本次未重测。**适配判断**：来自项目文档/工具输出的指令不能无条件升格为用户偏好或全局系统规则。

**本产品可借鉴一句话**：借鉴后台跨会话 synthesis 与可纠正机制，但选择比黑箱画像更透明的来源链、隔离边界和撤销策略。

## 6. 新兴产品：Memobase 与 memU（仅展开 consolidation 亮点）

### 6.1 Memobase：按 profile 槽合并 + 容量触发重整

- **机制/触发**：来源 [buffer.py](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/controllers/buffer.py)、[env.py](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/env.py)。聊天 buffer 到 token 阈值可 flush，也有后台/显式 flush；该快照配置 `max_chat_blob_buffer_token_size=1024`、`buffer_flush_interval=60*60`。不是每条输入都立即更新所有 profile。
- **当前实际调用与 prompt**：来源 [chat/__init__.py](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/controllers/modal/chat/__init__.py)、[merge_yolo.py](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/controllers/modal/chat/merge_yolo.py)、[merge_profile_yolo.py](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/prompts/merge_profile_yolo.py)。实际导入 **merge_yolo**，旧逐项 `merge.py` 留在仓库不是当前默认。按 `(topic, subtopic)` 精确匹配旧槽，把旧 memo、新信息、topic 描述和 update instruction 批量交给 LLM，选 `APPEND / UPDATE / ABORT`。关键原文：`is completely contained within the current memo`（应 ABORT）。UPDATE 整段重写，APPEND 代码直接分号拼接。
- **容量整顿**：来源 [organize.py](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/controllers/modal/chat/organize.py)、[organize_profile.py](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/prompts/organize_profile.py)。同 topic 的旧 subtopic 数超过 `max_profile_subtopics=15` 时，LLM 重组为至多 `max_profile_subtopics // 2 + 1` 个，并将旧 IDs 列入 delete、新结果列入 add；超长 slot 后续还可 re_summary。不是跨用户/跨项目泛化。

```text
flush(buffer):
  memo = summarize_chat(buffer)
  extracted_slots = extract_topics(memo, existing_profiles)
  actions = LLM(batch_merge_prompt, old_slot, new_info, per_slot_policy)
  APPEND -> concatenate; UPDATE -> replace_slot; ABORT -> unchanged
  if too_many_subtopics: reorganize_topic -> add_new + delete_old
  if slot_too_long: summarize_slot
  persist_profile_mutations_and_event_delta
```

- **已知问题**：[ #143](https://github.com/memodb-io/memobase/issues/143) 用户直接展示名字/食物偏好重复分号累积；[#166](https://github.com/memodb-io/memobase/issues/166) 报告 prompt 输出模板的字面 `ACTION` 与 parser 不兼容，导致 action 静默丢弃，源码当前仍可见缺 action 只 warning/continue。两者均 open，本次未跑实测。取舍：槽位降低候选歧义，却不自动保证语义去重、格式正确或无信息损失。**适配判断**：可借鉴每类记忆单独的 update policy 与容量触发；不抄分号堆叠、静默忽略异常或超限直接截断。

**可借鉴一句话**：为候选记忆类型/主题加约束比单一万能合并 prompt 更可靠，完整操作列表必须 schema 验证后才能执行。

### 6.2 memU：当前已经是 agent 驱动的 Markdown self-evolve

- **机制/触发/关键文件**：来源 [memorize/lifecycle.py](https://github.com/NevaMind-AI/memU/blob/bbf2d7040d00c0b5b41b72505085a1349d9b9af6/src/memu/app/memorize/lifecycle.py)、[bridging/instructions.py](https://github.com/NevaMind-AI/memU/blob/bbf2d7040d00c0b5b41b72505085a1349d9b9af6/src/memu/hosts/bridging/instructions.py)。`prepare_memorize` 镜像已有 recall files、建立 snapshot、生成每会话 memory/skill job；外部宿主 agent 执行；`commit_memorize` diff 后提交后端，成功再清理任务。没有必要套用旧介绍中的数据库 category-merging 作为当前事实。
- **判定者/prompt**：上述 memory job 三选 `Do nothing / Patch existing memory file(s) / Create a new memory file`。关键原文：`A no-op is a perfectly good outcome`；`last write wins when patching`。先读名字筛相关文件再读正文；技能模板也优先延展已有 task-family skill，不为相似分支不断建新 skill。

```text
prepare(sessions): mirror_existing_files; snapshot; generate_jobs
host_agent:
  inspect_relevant_existing_markdown
  select no_op / patch / create
  write_memory_or_reusable_skill
commit:
  collect_changed_files_from_snapshot
  send_commit_results
  cleanup_only_after_backend_success
```

- **取舍**：与目标 Markdown 形态很近，模型依赖宿主而非必须插件内置 provider；但文件名相关性筛选可能漏召回，last-write-wins 不是并发安全。**适配判断**：可把本项目泛化作为宿主 agent 的维护任务，不破坏 v1 零模型依赖；仍必须自行实现跨项目 namespace 与提交锁。
- **已知问题**：[#544](https://github.com/NevaMind-AI/memU/issues/544) 明确报告多宿主并行 memorize 会踩共享镜像/manifest/jobs，提出进程级锁；open，不把提案当已落地。当前 developer memorize 的 active_run 检查是可见保护，但不能据此宣称所有 host pipeline 均原子互斥。另 [#381](https://github.com/NevaMind-AI/memU/issues/381) 讨论多次压缩后记忆漂移；来自报告者的外部运行，不是 memU 官方 benchmark，本材料不采用其中百分比作产品结论。**适配判断**：验证生成全局条目对原文的保真、保留原证据，比再让同一模型自评“整理正确”更重要。

**可借鉴一句话**：用宿主 agent + 小型维护作业来做 Markdown consolidation 很自然，但宿主具备写工具并不等于安全跨层事务。

## 7. 共性模式总结（机制事实与本项目建议分开）

### 7.1 触发时机、判定者、更新操作的共性

| 维度 | 实际观察到的模式 | 直接证据 |
|---|---|---|
| 触发 | 写入内同步；轮末/压缩事件；延迟去抖；buffer/容量阈值；显式后台维护 | mem0 v1 add；Letta post-turn；LangMem ReflectionExecutor；Memobase buffer/organize；ChatGPT Dreaming |
| 候选形成 | 向量 top-k 只缩小范围；profile 使用结构化槽；Markdown agent 从文件名/描述定位；图用实体/关系范围 | mem0 main；Memobase merge_yolo；Letta/memU prompt；Graphiti edge_operations |
| 语义判定者 | 基本都是 LLM/agent；存储与检索本身不会完成语义冲突消解 | 各源码 hot path / background prompt |
| 判定输入 | 新证据 + 旧 canonical 状态 + scope/type/时间/策略；更完整证据允许更稳健的合并 | LangMem manager、Graphiti time、Memobase slot policy、Letta multi-transcript |
| 更新操作 | 不仅新增：更新/patch、整体重写、NONE/ABORT、删除/失效、归档、移层；具体产品能力不完全相同 | mem0 v1；Letta tools/reflection；Graphiti edge invalidation；LangMem diff；Memobase actions |
| 原件处置 | 图保留失效事实+episode；Markdown 可归档或修订源；ChatGPT 来源与记忆分离；有些简单路径仅 ADD | Graphiti edges；Letta reflection；OpenAI FAQ；mem0 当前 main |
| 正确性边界 | 候选漏召回、语义误判、范围扩大、并发快照失效、写失败静默、压缩丢限定语是独立风险 | Graphiti #1728/#1956；mem0 #6515；LangMem #196；Memobase #166；memU #544 |

**没有发现可直接照搬的统一机制**：“跨项目重复 N 次就安全地转全局并自动删除项目原件”。大多处理同一 user/agent/namespace 内的状态更新；Graphiti community 是摘要层、Letta core/deferred 是注入层，均不等价于我们 global/project 的权限与适用域改变。该否定结论限于本次读过的路径，不声称穷尽整个市场。

### 7.2 对 pi-scoped-memory 的综合判断（设计建议，不冒充产品事实）

1. **把重复、泛化、冲突分成不同问题**。重复表示断言等价；泛化表示去掉项目变量后仍对其他项目成立；冲突表示同一适用域下无法同时为真。来源依据：Graphiti 明确限制 duplicate/contradiction，Letta 先筛可泛化与暂态信息，mem0 ADD-only 反例说明只管新增不够。
2. **低成本候选发现不直接决定危险写入**。先靠现有 Markdown/索引做规范化、类型/关键词/稳定 hash 等筛选（这些是建议，不是产品共同实现），模型一次看到多个独立项目原文、现有全局目标及全部限定语；无法证明可泛化则 NOOP。依据：经典 mem0/Graphiti 的召回后裁决，以及 Graphiti 的范围/漏召回事故。
3. **提案与执行分离**。LLM 输出结构化 `NOOP / MERGE_IN_PROJECT / PROPOSE_GLOBAL / CONFLICT_REVIEW` 等计划、引用源条目、提议全局正文、每个项目应保留的差异；不直接任意写路径。先做 dry-run，再确定性验证 schema、scope 和输入版本。依据：LangMem 无副作用核心、Letta worktree/proposal integration。
4. **“写全局成功”后才让项目原件退出 active 注入**。优先保留来源指针/审计而不是立即物理删除；项目特有例外留在项目条目。两层正文、两个 MEMORY.md 与源处置在提交阶段按 manifest/journal 管理；中断可恢复、重试幂等。依据：Graphiti provenance+invalidation、Letta 成功 integration 才推进源进度、mem0 TOCTOU 与 LangMem 假成功问题。
5. **扩大作用域需要比普通更新更严格**。同一规则在多个项目重复可能只是同一种框架/团队惯例，不应丢掉“仅公司项目”“仅前端”“仅用户要求时”等限制；安全敏感/路径/凭据/生产流程默认不自动全局化。依据：Graphiti 限定语要求、Willison 隐式个性化污染反例；此处具体禁入政策是本项目建议。
6. **保持 v1 零模型依赖**。基础记忆仍纯 Markdown；consolidation 是可选维护命令/宿主 agent 后台任务，有频率/预算/开关；无模型时只发现候选、不静默降级为自动删除。依据：LangMem 独立 transformer、Letta/memU 宿主式后台维护。
7. **验收聚焦信息不丢和作用域不越界**。至少覆盖：同义重复、信息互补、项目例外、看似相同但不同适用域、真实冲突、只有一次证据、跨会话重复抽取、重试/并发、全局写失败/索引失败/源处置失败、用户忘记后不复活。不是只看条目数下降。依据：本材料各 issue 的直接反例。

**最终判断**：最值得组合的是 **Letta 当前 reflection 的后台工作流与提交隔离 + LangMem 的纯转换/多阶段判定 + Graphiti 的非破坏性失效与证据链 + 经典 mem0 的显式操作计划**；ChatGPT 提供后台长期 synthesis 的产品佐证，但闭源算法与历史逆向只能用于方向参照，不能作为实现保证。

## 8. 残余风险与未验证项

- 所有开源结论是指定快照的静态读取，未执行模型/DB；issue 为报告者证据，不把其数字当本次复现结果。
- 当前 mem0 与 Letta、memU 都发生架构变化，设计引用必须带版本锚点；不要把历史 prompt 存在等同于当前活跃调用。
- ChatGPT 真实后端 prompt、去重阈值、合并调度周期未公开；2024/2025 prompt 逆向不能证明 2026 Dreaming V3 内部算法。
- 浏览器技能启动失败已明确记录；网页采用降级抓取、开源采用实际源码，不采用记忆中的未经核实细节。
- 本任务只写本文件；不涉及修改插件、安装产品、调用付费模型或验证实际 token 成本。
