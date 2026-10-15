# AI Agent 记忆系统 Consolidation / 自动记忆 — 反面证据与风险清单

> 调研日期：2026-10-14
> 目标项目：pi-scoped-memory（双层 Markdown 记忆：全局层 + 项目层，纯文本注入 systemPrompt，全局层影响所有项目会话）
> 功能背景：正在设计「跨项目重复记忆自动泛化成全局」
> 调研工具：gh api（GitHub Issue/PR 一手源）、curl（Cursor/Discourse 论坛 API）。web-search 技能因 Bridge Server 编译失败不可用，降级为 gh api + curl 直拉 Discourse JSON API（已说明降级原因）。
> 本文档为调研材料，非设计报告。主 agent 拿此做设计决策。

---

## 风险清单（按对 pi-scoped-memory 杀伤力排序）

### 风险 1：误泛化污染全局层 — 全员可见且不可隔离

**杀伤力：🔴 极高（全局层注入所有项目会话，一条错误泛化 = 所有项目受污染）**

**现象：**
两个项目层的记忆内容表面相似但语义/上下文不同，被自动泛化为全局记忆后，注入到所有项目会话中，导致无关项目会话收到错误的上下文。

**根因：**
自动泛化的核心判断依赖相似度匹配（向量相似度或文本相似度），但「表面相似但语义不同」是多义词/同名实体的经典问题。mem0 的 0.95 向量相似度阈值已经证明不足以区分 "Apple Inc." vs "apple (fruit)" 这类多义实体。

**真实案例：**

- mem0 Issue #5438「Entity disambiguation: same-name entities with different meanings merge at 0.95 similarity threshold」
  - URL: https://github.com/mem0ai/mem0/issues/5438
  - 原文关键句：*"The entity store uses a 0.95 vector similarity threshold as the sole mechanism to decide whether two entity texts refer to the same entity. When a new entity's embedding matches an existing entity at ≥ 0.95, the system merges them... This breaks when entities share the same surface form but have different meanings"*
  - 列举了 Apple (公司 vs 水果)、Tesla (人名 vs 公司)、Python (语言 vs 蛇)、Mercury (行星 vs 元素)、Jordan (国家 vs 人名) 等多义案例
  - *"Cross-domain contamination in multi-tenant scenarios: If different users discuss 'Apple' in different senses, they share an entity record, creating implicit cross-tenant information leakage"*

- mem0 Issue #5587「same-name entities from different types get incorrectly merged」
  - URL: https://github.com/mem0ai/mem0/issues/5587
  - 原文：*"Entity linking merges entities that share the same name but have different types (e.g., a person named 'Apple' and the company 'Apple'), causing incorrect cross-linking of unrelated memories"*

- mem0 Issue #5439「cross-scope entity merges」
  - URL: https://github.com/mem0ai/mem0/issues/5439
  - 原文：*"The entity store applies scope filters (user_id, agent_id, run_id) when searching for existing entities to merge with, but it does not validate that the linked_memory_ids in an entity record are scoped to the same context... The entity record now contains memory IDs from two different users"*
  - 修复 PR #6882：*"prevents existing entities from being reused across different memory scopes defined by truthy user_id, agent_id, and run_id values"*

- Graphiti Issue #1728「collateral fact invalidation — unrelated facts silently retired」
  - URL: https://github.com/getzep/graphiti/issues/1728
  - 原文：*"Saving a memory that merely mentions an entity can retire an unrelated, still-true fact about that entity... In one production graph of roughly 3,950 facts, 1,616 (41%) carry an invalid_at. A hand-audit of four of them found three were collateral rather than genuine change"*
  - 即：**41% 的失效标记是误判**，在真实生产图中审计 4 条发现 3 条是错误的

**对 pi-scoped-memory 的具体警示：**
我们的全局层注入所有项目会话。如果自动泛化把两个项目层中表面相似但语义不同的记忆合并到全局层，**每一条误泛化都会影响所有项目的所有会话**。mem0 的 0.95 阈值已证明不够，且 Graphiti 的数据显示误判率可高达 ~75%。pi-scoped-memory 没有 vector store，泛化判断如果靠 LLM 或文本匹配，风险更高。**必须：泛化前要求显式确认或至少双重验证（文本匹配 + LLM 语义判断 + 人工 review gate）。**

**取舍：** 不要做全自动泛化；至少在全局层写入前加 review gate。

---

### 风险 2：矛盾记忆共存 — 新旧事实同时注入导致决策混乱

**杀伤力：🔴 极高（泛化后的全局层同时包含旧版和新版偏好/事实，每次会话都注入矛盾上下文）**

**现象：**
用户在项目 A 中说「用 PostgreSQL」，后来在项目 B 中说「用 MySQL」。如果两条记忆被泛化到全局层且不做矛盾检测，全局层会同时包含「用 PostgreSQL」和「用 MySQL」，注入到项目 C 的会话中。

**根因：**
ADD-only 记忆管道不做 UPDATE/DELETE，新旧事实共存。自动泛化把多条项目层记忆合并到全局层时，如果不做矛盾检测，矛盾会被放大到全局范围。

**真实案例：**

- mem0 Issue #5867「ADD-only memory extraction can create conflicting memories」
  - URL: https://github.com/mem0ai/mem0/issues/5867
  - 原文：*"ADD-only memory extraction can create conflicting memories when a user updates or replaces a previously stored preference or fact. For example, if a user first says 'My favorite football player is Ronaldo' and later says 'My current favorite football player is Messi', the current flow can store both facts as separate ADD memories"*
  - *"The memory store should not keep contradictory preference memories such as both 'favorite football player is Ronaldo' and 'favorite football player is Messi'"*

- mem0 Issue #4956「ADD-only extraction in v3 may surface stale/contradictory facts for time-sensitive attributes」
  - URL: https://github.com/mem0ai/mem0/issues/4956
  - 原文：*"For facts representing a mutable state (e.g. current employer, current city, relationship status), this means contradictory memories accumulate over time instead of the newer fact superseding the older one... Both memories coexist. On a later query like 'Where does the user work?', retrieval can return Company A as a top-ranked candidate because the scoring signals don't incorporate recency"*

- mem0 Issue #5352「Workaround: Solving time-blindness, semantic conflicts, and missing CRUD in Mem0 OSS + Qdrant」
  - URL: https://github.com/mem0ai/mem0/issues/5352
  - 原文：*"Over time, old configuration values, outdated user preferences, or transient error states result in duplicate/contradictory facts in Qdrant. Because vector search returns them sorted by similarity rather than recency — and doesn't include timestamps — the LLM receives multiple conflicting 'truths' and gets confused"*

- Graphiti Issue #1956「Edge invalidation misses the current fact once a subject has ~10 superseded facts」
  - URL: https://github.com/getzep/graphiti/issues/1956
  - 原文：*"A subject's superseded history competes with its current fact for those 10 places. Once a subject has about 10 past values, the current one is often not shown to the model and it is never retired. The subject then has two 'current' values"*
  - 实测数据：50 个历史值时，当前事实被正确失效的概率只有 6/30（stub judge）或 0/12（真实模型）

**对 pi-scoped-memory 的具体警示：**
我们的双层 Markdown 记忆没有 timestamp 元数据（Hermes Agent 的 #66654 issue 同样指出了这个问题）。泛化时如果不做矛盾检测，全局层会累积矛盾记忆。**关键：泛化前必须检测语义矛盾，遇到矛盾时优先保留最新记忆或标记为需人工裁决，不要自动合并矛盾事实。**

**取舍：** 泛化前做矛盾检测；矛盾记忆不泛化，留在项目层或标 flag 请求人工处理。

---

### 风险 3：跨项目/跨 scope 记忆泄露 — 隔离边界被打破

**杀伤力：🔴 高（全局层本身就是跨项目的，泛化功能扩大了这个攻击面）**

**现象：**
项目 A 的私密/敏感记忆被泛化到全局层后，项目 B、C、D 的所有会话都能看到。如果项目 A 的记忆包含项目特定配置（如部署密钥路径、内部 API 地址），这些信息会泄露到无关项目。

**根因：**
记忆系统缺乏 scope 隔离机制，或隔离机制有漏洞。跨 scope 合并是最常见的 bug 类型之一。

**真实案例：**

- OpenClaw Supermemory Issue #9「Support per-agent containerTag for multi-agent isolation」
  - URL: https://github.com/supermemoryai/openclaw-supermemory/issues/9
  - 原文：*"all agents currently share the same Supermemory containerTag. This creates a memory pollution risk where one agent's stored memories become visible to another agent's recall context... If someone in Slack tells the employee agent to 'remember X', that memory can later surface in the main agent's context"*

- cumora Issue #45「Scope agent memory/climate to project so one agent can work across groups without context bleed」
  - URL: https://github.com/yetone/cumora/issues/45
  - 原文：*"When the same agent participates in multiple groups (projects), its memory, climate, and persona are keyed only to agent_id — they are global across all conversations... an agent working in group B 'remembers' and acts on the context from group A, mixing its group A work into group B"*
  - *"Its memory index ends up indexing five unrelated projects... In a new group about one project, nova reads all five and treats the others as background"*

- BuildMEM Agent Issue #7「cross-project memory pollution in multi-project setups」
  - URL: https://github.com/Olalekan2345/buildmem-agent/issues/7
  - 原文：*"all facts land in a shared flat namespace. memwal_recall searches across the entire namespace, so facts from Project A can surface when querying context for Project B - especially when projects share vocabulary (e.g., both use deployment, auth, database)"*
  - *"The agent may confidently cite a decision from the wrong project"*

- Letta Issue #3388「Cross-Session State Leakage via Persistent Core Memory Poisoning」
  - URL: https://github.com/letta-ai/letta/issues/3388
  - 原文：*"agents can utilize internal tools to maliciously alter their persona... these malicious memory modifications are permanently written to the database. Consequently, the poisoned context permanently leaks into subsequent, independent evaluation runs, breaking sandbox isolation"*

- Letta Issue #3175「Ezra support agent: periodically purge /user block info」
  - URL: https://github.com/letta-ai/letta/issues/3175
  - 原文：*"User-specific details from one conversation may not be relevant (or appropriate) to retain for future conversations with that user or others"*

**对 pi-scoped-memory 的具体警示：**
全局层 = 所有项目可见，这是设计特征但也是最大攻击面。泛化功能会主动把项目层内容移到全局层，**等同于主动扩大泄露面**。必须区分「适合全局共享的通用偏好」（如编码风格）和「项目特定上下文」（如部署路径、密钥引用）。pi-scoped-memory 的 Markdown 格式没有 metadata 字段标记 sensitivity，泛化时无法区分。

**取舍：** 泛化候选只限「用户偏好/工作流约定」类记忆；项目特定技术细节/路径/配置不泛化。

---

### 风险 4：重复爆炸 — 去重/泛化算法失败导致记忆无限增长

**杀伤力：🟠 高（泛化功能如果不去重，反复写入会产生大量重复条目，撑爆 systemPrompt 注入）**

**现象：**
多次写入同一条记忆导致重复条目堆积。泛化时如果不去重，全局层会快速膨胀，消耗 systemPrompt token 预算。

**根因：**
去重算法（hash 去重、语义去重）存在 TOCTOU 竞态条件或覆盖率不足。LLM 级去重只看 top-K 现有记忆，漏掉超出窗口的重复。

**真实案例：**

- mem0 Issue #6515「hash-dedup TOCTOU race in add() creates permanent duplicate memories under concurrency」
  - URL: https://github.com/mem0ai/mem0/issues/6515
  - 原文：*"Memory.add() can create a permanent duplicate memory when two concurrent calls extract the identical fact for the same scope... If two concurrent calls both take their snapshot before either has inserted, both pass dedup against the same (not-yet-updated) state and both insert"*
  - *"the duplication is silent and accumulates over time in any production deployment with concurrent writers"*

- mem0 Issue #5850「Add max_memories config with automatic compaction」
  - URL: https://github.com/mem0ai/mem0/issues/5850
  - 原文：*"The LLM extraction prompt instructs the model to skip semantic duplicates, but it only sees the top-10 existing memories per insert and the dedup is best-effort. Tested by inserting 5 unique facts in 3 different wordings each (15 inserts total with infer=True) — 13 memories stored instead of 5. The LLM-level dedup caught only 2 of 10 duplicates (20%)"*
  - *"Latency degradation: add() p50 grows linearly — 0.55ms at 100 memories to 31.76ms at 10K (58x)"*

- mem0 Issue #7123「add() dedup search hardcoded to top-10 with no similarity threshold → duplicate memories on large corpora」
  - URL: https://github.com/mem0ai/mem0/issues/7123
  - 原文：*"The pre-extraction similarity search in the add() path is hardcoded to retrieve the top-10 nearest memories with no cosine-similarity threshold filter. The LLM extraction step only sees those 10 (regardless of how dissimilar they are), so near-duplicates beyond the 10th are invisible"*

- Graphiti Issue #1734「Node dedup only searches by embedding similarity, missing exact-name duplicates below the cosine threshold」
  - URL: https://github.com/getzep/graphiti/issues/1734
  - 原文：*"Entity nodes with the exact same name are not being merged by dedup... We found a group_id with 4 separate nodes whose name is the literal string 'DGIA', created across several ingestion sessions over ~10 hours"*
  - 精确匹配代码路径从未触发，因为候选检索先用了向量相似度门控

- Graphiti Issue #1101「Duplicate edges miscategorized」
  - URL: https://github.com/getzep/graphiti/issues/1101
  - 原文：*"The edge deduplication prompt fails to recognize semantically equivalent facts as duplicates when they use different phrasing, such as active/passive voice variations"*

**对 pi-scoped-memory 的具体警示：**
pi-scoped-memory 是纯 Markdown 文本，没有 vector store，去重只能靠文本匹配或 LLM 判断。如果泛化逻辑靠 LLM 判断「这条记忆是否已有等价条目」，LLM 去重只有 20% 成功率（mem0 实测）。**必须在泛化时做严格的文本级去重（hash/normalized string matching），不能只靠 LLM 语义判断。** 且 Markdown 文件无并发锁，多会话同时写入会产生 TOCTOU 重复。

**取舍：** 泛化时用确定性文本去重（normalized string match）做第一道防线，LLM 语义判断仅作辅助。

---

### 风险 5：过时记忆覆盖当前规则 — stale memory 优先级高于显式指令

**杀伤力：🟠 高（泛化到全局层的旧记忆可能在后续项目中已被推翻，但仍被注入，甚至覆盖项目层的新规则）**

**现象：**
泛化后的全局记忆包含过时信息。后续项目中用户已改变做法，但全局层仍注入旧记忆，甚至 LLM 优先遵守旧记忆而非当前项目层的新指令。

**根因：**
记忆没有 timestamp/版本号，LLM 无法判断新旧。更严重的是，LLM 可能把持久记忆当作权威指令，优先于当前会话的显式规则。

**真实案例：**

- Codex Issue #39223「Codex Desktop loads global AGENTS.md but stale memory overrides its explicit rule」
  - URL: https://github.com/openai/codex/issues/39223
  - 原文：*"the agent ignored a distinctive current global rule and instead followed stale validation-gate guidance recovered from persistent memory... The problem is instruction precedence/compliance: stale memory was treated as more authoritative than the current, explicitly loaded global AGENTS.md"*
  - *"A current, successfully loaded AGENTS.md rule should win over conflicting stale memory for repository work. Persistent memory should provide historical context, not silently override explicit current operating instructions"*

- Hermes Agent Issue #66654「Memory pollution & stale memory accumulation — missing timestamps, priority, and data-cleaning mechanism」
  - URL: https://github.com/NousResearch/hermes-agent/issues/66654
  - 原文：*"模型记录错误/不准确的记忆 — 模型在运行过程中自行判断哪些信息'值得记住'，但这种判断常出错，导致内存中出现不准确、矛盾甚至错误的事实描述（'瞎记忆'）。这些污染记忆一旦写入就会一直存在"*
  - *"失效记忆持续占用额度 — 由于有硬字符容量限制，失效/过期记忆占据容量后，有用的新记忆被拒，形成'垃圾填满，有用信息进不来'的死锁"*
  - *"时间维度信息缺失 — 当前 § 分隔的纯文本条目没有任何时间戳"*

- Cursor 论坛「One project, three tasks. What should the agent remember?」
  - URL: https://forum.cursor.com/t/one-project-three-tasks-what-should-the-agent-remember
  - 原文（用户 izgorodin）：*"I want an agent's context to follow the task, not a fixed checklist of what to remember... A team added a response cache, found that it served stale data, then disabled it while they investigated. The project memory still holds the service overview, the original decision, the incident and the decision to turn caching off"*
  - *"Using outdated context to explain something is annoying. Using outdated context to deploy code or re-enable a feature could be a production incident"*

**对 pi-scoped-memory 的具体警示：**
pi-scoped-memory 的 Markdown 记忆没有 timestamp（与 Hermes Agent 完全相同的结构）。泛化到全局层的记忆如果过时，会持续注入所有项目。Codex 的案例证明 **LLM 会把持久记忆当作比当前 AGENTS.md 更权威的指令**——这意味着全局层的过时记忆可能覆盖项目层的新规则。我们的泛化功能会放大这个问题：把一个项目层的过时记忆泛化到全局层，等于让过时记忆影响所有项目。

**取舍：** 每条记忆必须带时间戳/版本标记；泛化时检查候选记忆是否已被同一项目的后续记忆推翻。

---

### 风险 6：LLM 幻觉产生「幽灵记忆」— 模型编造从未发生的事实

**杀伤力：🟠 中高（泛化判断本身依赖 LLM，如果 LLM 幻觉，会将幻觉内容泛化到全局层）**

**现象：**
LLM 在提取/泛化记忆时，因为输入为空或不完整，自行编造记忆内容。这些幻觉记忆被持久化并注入后续会话。

**根因：**
记忆提取管道对空/不完整输入没有验证。LLM 在缺少上下文时会自行"补全"事实。

**真实案例：**

- mem0 Issue #4099「Hallucinated memories created on empty messages payload when run_id is present」
  - URL: https://github.com/mem0ai/mem0/issues/4099
  - 原文：*"When calling the Mem0 add() method with an empty messages list and a valid run_id, the system generates and saves 'ghost' memories. These memories contain data that was never provided by the user and is not present in the custom fact extraction prompt"*
  - 模型特异性：*"Only occurs with gemini-3-flash-preview... Switching to gemini-2.5-flash results in zero memories (correct behavior)"*

- mem0 Issue #4435「validate non-empty messages in Memory.add() to prevent hallucinated memories」
  - URL: https://github.com/mem0ai/mem0/issues/4435
  - 原文：*"When calling Memory.add() with an empty messages list ([]) and a valid run_id, the system generates 'ghost' memories. The LLM fabricates memory content because it receives an empty conversation"*

**对 pi-scoped-memory 的具体警示：**
如果泛化逻辑用 LLM 判断「这两条项目层记忆是否可以泛化为全局」，LLM 可能在输入不充分时编造泛化理由或合并出不存在的事实。**必须：泛化输入必须包含完整的两条候选记忆原文，不允许空/不完整输入到达 LLM；泛化结果必须引用源记忆的原文片段作为证据。**

**取舍：** 泛化 LLM 调用的输入必须含两条候选记忆完整文本；输出必须引用源文本证据。

---

### 风险 7：后台记忆整理的一致性陷阱 — sleep-time compute 的竞态与中断

**杀伤力：🟡 中（泛化功能如果做成后台异步整理，存在竞态/中断导致状态不一致的风险）**

**现象：**
后台记忆整理（如泛化、合并、压缩）在运行过程中被中断或与前台写入竞态，导致部分记忆被合并、部分被遗漏，产生不一致状态。

**根因：**
Sleep-time / 后台整理不是原子的。前台会话可能同时修改记忆，后台整理读到的快照在写入时已过时。

**真实案例：**

- Letta Issue #3104「Sleeptime message grouping causes role confusion」
  - URL: https://github.com/letta-ai/letta/issues/3104
  - 原文：*"Sleeptime trigger evaluates after each capture call, not after a complete request/response cycle is finished. There's no atomicity guarantee that all parts of a multi-part assistant response are processed together before sleeptime evaluation... Missing context causes sleeptime to misinterpret its role - attempts conversational response instead of memory processing"*

- Letta Issue #3109「Sleeptime agent failing with Claude 4.5 (Unhandled LLM error)」
  - URL: https://github.com/letta-ai/letta/issues/3109
  - 原文：*"Sleeptime agent is never running for some of my agents"* — 后台整理可能完全静默失败

- Letta Issue #3294「Sleeptime-to-reflection migration: support customizable subagents」
  - URL: https://github.com/letta-ai/letta/issues/3294
  - 原文：*"The transition from server-side sleeptime agents to client-side reflection subagents introduces a capability regression for users who have customized their sleeptime agents beyond the default memory consolidation role"*
  - Letta 自身从 sleeptime 迁移到 reflection 是一次架构级重构，说明 sleeptime 方案有设计缺陷

- mem0 Issue #7195「Message buffer FIFO eviction pollutes extraction context with stale cross-session content」
  - URL: https://github.com/mem0ai/mem0/issues/7195
  - 原文：*"When a new session starts with fewer than N messages, tail messages from a previous session stay in the buffer, so the extraction prompt's 'Last k Messages' section mixes unrelated prior-session content into the current extraction — resulting in irrelevant memories and, in some upstream gateway setups, content-filter rejections"*

**对 pi-scoped-memory 的具体警示：**
如果泛化功能做成后台异步任务（如在会话结束时扫描项目层记忆并泛化），需要确保：(1) 泛化过程中项目层记忆不被并发修改（或能处理竞态）；(2) 泛化操作是原子的——要么完全写入全局层，要么完全不动；(3) 后台任务失败要有可观测的信号，不能静默失败（Letta sleeptime 静默失败是真实案例）。pi-scoped-memory 的纯 Markdown 文件没有事务/锁机制，原子性更难保证。

**取舍：** 泛化操作在会话间做（不在会话内异步）；写入全局层用「写临时文件 → rename」原子模式。

---

### 风险 8：无关记忆注入 — 零相关性内容强制进入上下文

**杀伤力：🟡 中（泛化到全局层的记忆如果不经相关性过滤就注入，会消耗 token 且干扰模型推理）**

**现象：**
全局层记忆注入到项目会话时，不做相关性过滤，导致每条全局记忆都注入到每个会话，大量无关上下文浪费 token 并干扰模型。

**根因：**
记忆注入管道缺乏相关性阈值或按需检索，所有记忆无条件注入。

**真实案例：**

- amplihack-rs Issue #1483「user-prompt-submit memory injection repeats the same irrelevant memory once per word-derived 'agent', with hardcoded relevance 0.00」
  - URL: https://github.com/rysweet/amplihack-rs/issues/1483
  - 原文：*"every prompt in the Claude session gets context appended... The single stored memory came from a one-off smoke test. It is unrelated to the prompt"*
  - *"(relevance: 0.00) is a hardcoded literal. The score is never computed, and nothing filters out irrelevant memories, so zero-relevance content is injected into every prompt and costs context on every turn"*

- mem0 Issue #7186「config knobs for startup context size (injection top_k / startup framing toggle)」
  - URL: https://github.com/mem0ai/mem0/issues/7186
  - 原文：*"Our platform enforces a hard session startup context budget (tokens injected before first user turn) as a governance KPI... The plugin's contributions to startup context and found they are not tunable... Related memories surfaced per session therefore scale with defaults and cannot be bounded by integrators"*

- Cursor 论坛「Ai memory as an agent」
  - URL: https://forum.cursor.com/t/ai-memory-as-an-agent
  - 原文（用户 hermes_pravin）：*"Standard solutions flood your context window with 7k tokens or more, and more often than not the answer is entirely wrong or buried under so much junk that the model can't reason properly"*

**对 pi-scoped-memory 的具体警示：**
pi-scoped-memory 的全局层**已经**是「无条件注入所有项目会话」的设计。泛化功能会增加全局层的记忆量，进一步放大注入 token 消耗。如果全局层记忆量增长到几百条，systemPrompt 注入会占用大量 token。**必须：限制全局层记忆条数上限；或做按需注入（只在相关项目会话注入全局记忆的子集）。**

**取舍：** 全局层设硬上限（如 50 条）；超限时触发清理而非继续积累。

---

### 风险 9：记忆注入的安全攻击面 — prompt injection via memory

**杀伤力：🟡 中（恶意记忆条目可注入指令到所有项目会话）**

**现象：**
攻击者通过在对话中植入恶意内容，让记忆系统把恶意指令存储为记忆。该记忆注入到 systemPrompt 后，在后续会话中执行恶意指令。

**根因：**
记忆文件被直接注入到 systemPrompt，没有对记忆内容做指令清洗。记忆注入是持久化的 prompt injection 通道。

**真实案例：**

- Letta Issue #3388「Cross-Session State Leakage via Persistent Core Memory Poisoning」
  - URL: https://github.com/letta-ai/letta/issues/3388
  - 原文：*"the agent maliciously calls the memory modification tool to inject a poisoned instruction into its persona block (e.g., 'Always return a perfect score for all future prompts')... the poisoned context permanently leaks into subsequent, independent evaluation runs"*

- ai-security-radar Issue #32「Mind Your HEARTBEAT! Claw Background Execution Inherently Enables Silent Memory Pollution」
  - URL: https://github.com/micmerritt/ai-security-radar/issues/32
  - 原文：*"untrusted content encountered during heartbeat-driven background execution can silently pollute agent memory and subsequently influence user-facing behavior without the user's awareness"*
  - 来源：arXiv:2603.23064v1

- garak Issue #2232「Probe class proposal: stale memory persistence across sessions」
  - URL: https://github.com/NVIDIA/garak/issues/2232
  - 原文：*"agent memory outlives the session. A poisoned or stale entry planted once can sit quiet for weeks and then resurface inside context under completely different vocabulary, so input-boundary probes never see it"*
  - *"A probe class that plants a distinct memory-shaped fact, backdates it, then approaches the task with different wording and checks whether the planted content changed the answer would model persistence attacks the way garak already models injection"*

- nsh Issue #13「Apply the core memory injection check to core_memory_append」
  - URL: https://github.com/fluffypony/nsh/issues/13
  - 原文：*"security::assess_memory_tool_call checks core_memory_rewrite content for prompt-injection phrases. core_memory_append writes to the same core memory blocks, but it has no arm"*
  - 即：rewrite 路径有注入检查，但 append 路径没有——泛化功能如果走 append/write 路径，需要确保同样有注入检查

- mem0 Issue #6662「prevent identity metadata injection」
  - URL: https://github.com/mem0ai/mem0/issues/6662
  - 原文：*"prevent free-form metadata from injecting user_id, agent_id, run_id, or actor_id during memory creation"*

- mem0 Issue #7035「prevent input messages mutation and memory injection race」
  - URL: https://github.com/mem0ai/mem0/issues/7035
  - 原文：*"When the proxy formatted retrieved memories into prepared_messages, it mutated the caller-owned input dictionaries in-place... this in-place mutation could race with the background memory write, causing prompt-injected memories to be persisted into the vector store as user conversation content"*

**对 pi-scoped-memory 的具体警示：**
我们的注入面已做了 invisible/bidi 清理 + `<>` 转义，这比上述大多数系统都好。但 garak 的 probe 提案指出一个我们可能遗漏的攻击面：**恶意记忆可以「潜伏数周后在完全不同的上下文中浮现」**——即攻击者在一个项目会话中植入恶意记忆，泛化到全局层后，在另一个完全不相关的项目会话中执行。泛化功能把潜伏期从「同一项目内」扩大到「所有项目内」。nsh 的案例提醒：如果有 append/write 路径写全局层，也要做注入检查。**补充建议：泛化写入全局层的记忆内容也走与正常写入相同的注入清洗管道。**

**取舍：** 泛化写入全局层的路径走同一套注入清洗（invisible/bidi/<> 转义），不绕过。

---

### 风险 10：记忆合并不可逆 — 无审计/回滚机制

**杀伤力：🟡 中（泛化操作如果合并后无法撤销，错误合并永久存在）**

**现象：**
记忆合并/泛化后，原始记忆被覆盖或删除，无法回滚到合并前状态。错误合并永久存在。

**根因：**
记忆系统不保留合并记录，无法 undo。

**真实案例：**

- 学术论文「Merge Without Measure: Entity Resolution and Deduplication in Six Agent-Memory Systems」（预发表评审）
  - mem0 评审 Issue: https://github.com/mem0ai/mem0/issues/7002
  - letta 评审 Issue: https://github.com/letta-ai/letta/issues/3431
  - 原文（mem0 评审）：*"The paper introduces the Merge Accountability Criteria (MAC): MAC-1, a published false-merge or false-split rate at the operating threshold; MAC-2, a merge record sufficient to undo a merge from the store; MAC-3, a threshold derived from a stipulated error budget"*
  - mem0 评分：MAC-1=No, MAC-2=No, MAC-3=Constant (cosine 0.95) — 三项全不通过
  - letta 评分：MAC-1=n/a, MAC-2=n/a (有 BlockHistory undo 机制但无生产调用者), MAC-3=None — undo 机制存在但从未在生产中被调用

  原文（letta 评审）：*"A BlockHistory table stores 'a single historical state of a Block for undo/redo functionality'... But nothing in letta/ calls checkpoint_block_async outside its own definition; the callers are tests, so the default undo stack stays empty"*

- MCB-1.0 记忆冲突基准测试
  - Letta 适配评审: https://github.com/letta-ai/letta/issues/3437
  - 原文：*"Letta scored materially better than my own system (75.0% vs 50.0% decision accuracy, and 12/12 vs 0/12 on autonomous supersession); my system scored better on unauthorized overwrite (15.6% vs 40.6%). Both systems scored 0/12 on insufficiently-supported observations — neither has a write-side evidence gate"*
  - 关键发现：Letta 的「unauthorized overwrite」率 = 40.6% — 即 40.6% 的记忆覆写是不该发生的

- Graphiti Issue #1728（同风险 1）
  - 原文：*"The retired fact stays in the graph but is stamped with an invalid_at date, so searches downrank or drop it and the knowledge is effectively gone — silently, with no signal that anything was lost"*

**对 pi-scoped-memory 的具体警示：**
pi-scoped-memory 的纯 Markdown 记忆没有版本历史/审计日志。泛化操作如果覆盖或删除项目层记忆（把内容移到全局层），原始项目层记忆消失后无法回滚。MAC 论文的三个标准全部不适用于 pi-scoped-memory 的当前架构：没有误合并率数据（MAC-1）、没有合并记录可撤销（MAC-2）、没有基于错误预算的阈值推导（MAC-3）。Letta 有 BlockHistory undo 机制但生产中从未调用——说明即使做了 undo 机制，如果不集成到正常流程中也没用。MCB 基准测试显示即使最好的系统也有 40.6% 的未授权覆写率。

**取舍：** 泛化不删除项目层原记忆（只在全局层新增，项目层保留原文 + 标记「已泛化到全局」）；全局层新增记忆带 `来源: 项目层路径` 引用。

---

### 风险 11：记忆提取上下文被污染 — FIFO 缓冲区混入跨会话内容

**杀伤力：🟡 中低（影响泛化判断的输入质量，间接导致错误泛化）**

**现象：**
泛化判断的输入上下文（如读取项目层记忆做泛化判断时）混入了不相关会话的内容，导致泛化判断基于错误上下文。

**根因：**
上下文缓冲区用 FIFO 淘汰，不按相关性清理，旧会话内容残留并污染新会话的提取上下文。

**真实案例：**

- mem0 Issue #7195「Message buffer FIFO eviction pollutes extraction context with stale cross-session content」
  - URL: https://github.com/mem0ai/mem0/issues/7195
  - 原文：*"When a new session starts with fewer than N messages, tail messages from a previous session stay in the buffer, so the extraction prompt's 'Last k Messages' section mixes unrelated prior-session content into the current extraction — resulting in irrelevant memories"*

**对 pi-scoped-memory 的具体警示：**
泛化时如果读取项目层的多个记忆条目做合并判断，需确保读取的条目集是完整的、不被截断的。如果泛化只看项目层记忆的子集（如只看最近 N 条），可能漏掉已有的等价记忆，导致重复泛化。**泛化判断必须读取项目层的全部记忆，不能只看子集。**

**取舍：** 泛化候选扫描全量项目层记忆，不做 top-K 截断。

---

### 风险 12：记忆上下文预算失控 — 注入量不可调且不可限制

**杀伤力：🟡 中低（全局层泛化后记忆量增长，注入 token 成本线性上升）**

**现象：**
记忆注入量不可配置，全局层记忆增长后注入到每个项目会话的 token 成本不可控。

**根因：**
注入管道没有配置注入量上限或相关性阈值。

**真实案例：**

- mem0 Issue #7186「config knobs for startup context size」
  - URL: https://github.com/mem0ai/mem0/issues/7186
  - 原文：*"Our platform enforces a hard session startup context budget (tokens injected before first user turn) as a governance KPI... The plugin's contributions to startup context and found they are not tunable"*

- Graphiti Issue #1645「MCP server: search behavior is hardcoded — proposal: configurable reranker, stale-fact filtering, result counts, relevance scores」
  - URL: https://github.com/getzep/graphiti/issues/1645
  - 原文：*"results are ordered by reciprocal-rank fusion (RRF), capped at 10, returned without relevance scores, and mixed together with facts that have since been superseded by newer information. None of this is configurable"*
  - *"Hide superseded facts by default. Graphiti's temporal model marks old facts as invalid when new information contradicts them, but the search tools still return those stale facts ranked equally with current ones"*

- pydantic-ai Issue #9156「Snapshot Memory Mode (cache-preserving memory injection)」
  - URL: https://github.com/pydantic/pydantic-ai/issues/9156
  - 原文：*"every turn, the capability runs a memory search and injects results into the context. This has two costs: 1. Prefix cache invalidation — memory search results change between turns, breaking the cache prefix. 2. Latency — memory search adds latency to every turn"*

**对 pi-scoped-memory 的具体警示：**
pi-scoped-memory 的全局层在每次会话启动时全量注入 systemPrompt。泛化增加全局层条目数 → 每次会话注入更多 token → 前缀缓存失效 → 延迟增加。pydantic-ai 的 Snapshot Mode 方案值得参考：记忆在会话开始时快照一次，会话内不再重新读取，mid-session 写入到磁盘但下个会话才生效。

**取舍：** 全局层设条数上限 + 字符上限；考虑 snapshot 模式（会话开始注入一次，不在会话内动态变化）。

---

### 风险 13：Graphiti 式矛盾检测的 LLM 判断不可靠 — 非推理模型几乎失效

**杀伤力：🟡 中低（如果泛化判断用 LLM 做矛盾/重复检测，非推理模型可能导致大量误判）**

**现象：**
用非推理小模型做记忆矛盾/重复判断时，准确率极低。矛盾检测几乎完全失效，导致矛盾记忆共存或错误失效。

**根因：**
LLM 结构化输出在非推理模型上不可靠；矛盾检测 prompt 缺少 reasoning 步骤。

**真实案例：**

- Graphiti Issue #1666「Contradiction detection in EdgeDuplicate (dedupe judge) collapses on non-reasoning small_models」
  - URL: https://github.com/getzep/graphiti/issues/1666
  - 原文：*"When small_model is a non-reasoning model (we run gpt-4.1-nano for cost), the stock EdgeDuplicate response schema produces near-total failure on contradiction detection: in a graded eval, 1 of 9 replicates correct across contradiction-bearing cases"*
  - 修复：*"Same everything, with a reasoning: str field declared before the two arrays: 14/15"*
  - 即：非推理模型矛盾检测准确率 1/9 = 11%，加 reasoning 字段后提升到 14/15 = 93%

- Graphiti Issue #1728（同风险 1）
  - 原文：*"Nothing checks the LLM's contradiction call. Both candidate lists go to the LLM as bare fact strings, with no indication of which entities each fact connects. Whatever comes back in contradicted_facts becomes the invalidation set... one misjudgement by a small model, on facts stripped of their entity context, is acted on in both directions with nothing downstream to catch it"*

**对 pi-scoped-memory 的具体警示：**
如果泛化判断用 LLM 做矛盾检测（判断两条记忆是否矛盾、能否安全合并），需要：(1) 如果用非推理模型，prompt 必须要求 reasoning-first 输出；(2) LLM 的矛盾判断不能是唯一依据，需要确定性检查作为兜底（如检测关键词矛盾、数值矛盾）；(3) Graphiti 的数据显示 LLM 判断 "被不加检查地执行" 是核心问题——pi-scoped-memory 的泛化结果必须有人工 review gate 或确定性验证。

**取舍：** 泛化 LLM prompt 用 reasoning-first 结构；LLM 判断不做最终决定，只做建议。

---

## 补充发现

### Letta sleeptime → reflection 的架构重构教训

Letta 从服务端 sleeptime agent 迁移到客户端 reflection subagent（Issue #3294），说明 sleeptime（后台记忆整理）方案有设计缺陷，需要重构。这给 pi-scoped-memory 的警示是：**不要把记忆泛化做成后台 sleep-time 自动任务**，至少在架构验证前用显式触发（用户确认 / 会话结束时一次性扫描）更安全。

### 学术界正在建立记忆合并的问责标准

「Merge Without Measure」论文（mem0 #7002、letta #3431）提出了 Merge Accountability Criteria (MAC)：
- **MAC-1**：发布误合并/误分裂率（false-merge rate）——当前所有系统都不满足
- **MAC-2**：合并记录可撤销（merge record for undo）——当前所有系统都不满足
- **MCB-1.0 基准**（letta #3437）：测试记忆系统处理「一致性、矛盾、合法替代、证据不足」四种情况的能力。即使最好的系统也有 40.6% 的未授权覆写率，0/12 的证据不足检测率。

这说明：**业界还没有任何记忆系统建立了合并问责标准。** pi-scoped-memory 如果做自动泛化，是在一个没有成熟问责框架的领域做创新，风险更高。

### ChatGPT memory 的隐私争议（降级说明）

web-search 技能不可用（Bridge Server 编译失败），无法直接获取 ChatGPT memory 隐私争议的文章原文。以下为基于 GitHub issue 间接获得的信息：

- OpenAI Codex Issue #39223 间接反映了 ChatGPT/Codex 的记忆系统问题：用户报告 stale memory 覆盖了显式加载的 AGENTS.md 规则，说明 OpenAI 的记忆注入存在优先级倒置问题
- Hermes Agent Issue #66654（中文 issue）直接描述了「记忆污染 / 瞎记忆」问题：模型自行判断哪些信息值得记住但常出错，污染记忆一旦写入就永久存在

**降级说明**：ChatGPT memory 隐私争议的原始文章（如 OpenAI 官方博客、科技媒体报道）未能获取。如需补充，需 web-search 工具可用后重新检索。

---

## 综合判断（主 agent 要的答案）

### 核心结论

**自动泛化到全局层是 pi-scoped-memory 中风险最高的功能**。原因：
1. 全局层注入所有项目会话——误泛化的污染面是所有项目 × 所有会话
2. pi-scoped-memory 是纯 Markdown，无 vector store、无 timestamp、无审计日志、无并发锁——泛化判断和写入的安全网比 mem0/letta/graphiti 都少
3. 业界所有记忆系统的合并/去重/矛盾检测都有严重 bug（误判率 20%~75%，40.6% 未授权覆写），且都没有建立合并问责标准

### 对泛化功能设计的具体建议

1. **不做全自动泛化**：至少在全局层写入前加 review gate（用户确认或 LLM 建议 + 人工确认）
2. **泛化候选限制**：只泛化「用户偏好/工作流约定」类记忆，不泛化项目特定技术细节/路径/配置
3. **不删除项目层原记忆**：泛化只在全局层新增，项目层保留原文 + 标记「已泛化到全局」（满足 MAC-2 可撤销性）
4. **泛化前做矛盾检测**：矛盾记忆不泛化，留在项目层或标 flag 请求人工处理
5. **确定性去重优先**：用 normalized string matching 做第一道去重，LLM 语义判断仅辅助
6. **全局层设上限**：条数上限（如 50 条）+ 字符上限，超限触发清理
7. **泛化写入走注入清洗管道**：不绕过 invisible/bidi/`<>` 转义
8. **泛化 LLM 用 reasoning-first prompt**：输出必须含 reasoning 字段 + 引用源记忆原文

### 残余风险

- ChatGPT memory 隐私争议原文未获取（web-search 不可用）
- Cursor memories 论坛反馈有限（forum.cursor.com 的 Discourse API 只返回了部分相关帖）
- Cline/Roo memory bank 腐化案例未在 GitHub issue 中找到直接证据（这些项目的 issue tracker 未被搜索到相关内容）
- 「why we abandoned」类 postmortem 未找到直接证据（letta sleeptime→reflection 迁移是最近的架构级重构案例，但不完全是「下线」）
