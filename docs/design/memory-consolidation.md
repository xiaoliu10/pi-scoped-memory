# 跨项目记忆自动泛化（memory consolidation）调研与设计

> 真实意图：把「多个项目层重复出现的记忆」自动泛化成全局记忆，先调研业界做法（含 Claude Code 记忆实现逆向）再定方案。
> 日期：2026-10-15 / 状态：待评审
> 调研材料全文：`docs/design/research/{a-claude-code,b-memory-products,c-coding-agents,d-pitfalls}.md`（共 1390 行，一手源优先）

## 0. 问题定义

- **真实意图**：用户的多项目工作流产生了大量重复记忆（同一约定在多个项目层各写一份）。希望系统能识别跨项目重复并提炼为全局事实，使新会话在**所有项目**受益，而不是等用户手工搬运。
- **本项目约束**：
  - 双层结构：全局 `~/.pi/agent/memory/` + 项目层 `~/.pi/agent/memory-projects/<slug>-<hash16>/`，纯 Markdown 一事一文件 + MEMORY.md 索引。
  - v1 零运行时依赖 + **零模型依赖**（无自动提取）——泛化判定需要 LLM，这是核心张力。
  - 注入是「读一次冻结快照」（session_start），泛化写盘只影响新会话，KV cache 稳定性天然安全。
  - 硬约定：失败降级不阻断、路径 containment、注入面 invisible/bidi 清理（AGENTS.md）。
- **好产出标准**：给出 ≥2 个候选方案（改动面/风险/侵入度对比）+ 推荐方案的数据流、文件级改动清单、分阶段实施；另一个 agent 能据此直接动手。
- **用户已拍板的方向**：按 Claude Code 的结论（刻意不做全自动，显式触发 + 用户确认）做**显式触发的泛化工具**。

## 1. 现状与接入点（Phase 1）

### 1.1 数据流（改动前）

```
session_start → collectLayers(cwd)                    inject.ts
  → 读全局 MEMORY.md (~/.pi/agent/memory/)            ├─ 全局层在前
  → 读项目 MEMORY.md (~/.pi/agent/memory-projects/…)  └─ 项目层在后（缺失静默跳过）
  → buildMemoryBlock() → 冻结进 systemPrompt（会话内字节不变）

工具调用 → store.ts
  writeFact()  → resolveTarget(type, target)          user|feedback→global; project|reference→project
              → factFile(root, name)                  扁平一层，名字白名单 ^[a-z0-9][a-z0-9-]{0,79}$
              → renderFact(existing, meta, body)      ★已有 originSessionId ⇒ 整文件原样返回（no-op）
              → upsertIndexLine(MEMORY.md)            同名原位替换/追加
  searchMemory() → 子串匹配（跨两层）
```

### 1.2 泛化功能的接触面（代码级）

| 接触点 | 位置 | 现状与含义 |
|---|---|---|
| 遍历所有项目层 | `paths.ts` `projectMemoryRoot()`；母目录 `~/.pi/agent/memory-projects/` | 列母目录即可枚举全部项目层（当前 10 个）；hash 键稳定。**需新增 `enumerateProjectRoots()`** |
| 候选簇粗筛 | `store.ts` `searchMemory()` + `facts.ts` `parseFact()` | 解析器可直接复用；子串匹配只够粗筛，语义聚类留给 LLM 判定步 |
| 唯一写入路径 | `store.ts` `writeFact()` | 路由/索引 upsert/origin 补齐现成；**但 renderFact 对已有 origin 的文件是 no-op**（`facts.ts`：*「已有非空 origin：整文件原样保留（由调用方决定覆盖策略）」*）⇒ apply 更新既有全局事实必须走自定义写入路径，不能盲调 writeFact |
| 泛化结果路由 | `store.ts` `resolveTarget()` | 泛化产物 type=user/feedback 默认进全局，路由零改动 |
| 注入契约 | `inject.ts` `collectLayers()`/`truncateIndex()` | 全局索引 ≤200 行/25K 字符截断——泛化会增加全局条目，触及截断上限（需告警） |
| frontmatter 容错 | `facts.ts` `parseFact()` | name/description/type 齐全才有 meta，否则 meta=null 仍可读 body——机械扫描按 meta=null 兜底 |

### 1.3 项目内同类实现

无 consolidation。最接近的语义是 `upsertIndexLine()`（同名原位替换）与 `renderFact()` 的 origin 保护（版本化雏形）。

### 1.4 真实数据形态（2026-10-15 快照）

- 全局层 35 个条目：**手工混合格式**（HTML 注释时间戳 + `#` 分组标题），非严格 pointer 格式 ⇒ 机械解析/改写全局索引必须容错，且**不可假设格式归一**。
- 项目层 10 个（litellm 31 条为 zcode 迁移存量）：索引为密集 hook 行，上下文丰富。
- 已有「人工泛化」实例：全局层 `dashboard-currency-cny`（平台金额统一 ¥）、`dropdown-cap-visible-rows`（UI 偏好）实为从项目经验提炼的跨项目偏好——证明泛化有价值，也给出泛化产物的目标形态样本。

### 1.5 已知约束与坑

- README 提到「scripts 跑索引补录」但 `scripts/` 目录不存在 ⇒ 索引工具化欠账。
- 全局层注入所有项目会话 ⇒ 误泛化污染面最大。
- 项目层实测含凭据/服务器 IP 类记忆（`litellm-test-server-access`）⇒ 泛化判定必须显式过滤敏感内容。

## 2. 外部调研

### 2.1 Claude Code 记忆实现逆向（本机 v2.1.300，二进制内嵌 JS 源块直证）

材料：`research/a-claude-code.md`（244 行）。要点：

- **CLAUDE.md 分层**：managed → user（`~/.claude/CLAUDE.md` + `rules/`）→ project → local，全拼接不覆盖、根→叶排序；@import ≤4 跳；单文件 4MiB 上限。
- **自动记忆存在且默认开**：`~/.claude/projects/<sanitized-cwd>/memory/`，一事一文件 + frontmatter `type: user|feedback|project|reference` + MEMORY.md 索引（200 行/25KB，常量 `AF=200, tae=25000` 直证）——**与 pi 现行格式完全同源**。
- **跨项目泛化：没有，且刻意不自动化**。dream（`autoDreamEnabled`）只做单项目目录内整合；提示词明文 *"Do not promote personal memories into team/ during a dream — that's a deliberate choice the user makes"*；文档明文 "Auto memory is machine-local"。项目→全局纯手工。
- **写侧纪律可抄**：索引超限显式报错、**凭据拒写**、symlink 逃逸拒绝、in-loop 写入两步走（先 topic 文件再索引行，"Never write memory content directly into MEMORY.md"）。
- **反面证据**：#33895 全局层泄漏项目细节（真实事故）、#95079 低价值任务反复写记忆、#87027 用户求跨项目同步官方未做。
- **适配判断**：CC 团队显然判定**自动上浮风险 > 收益**。pi 的泛化是差异化机会，但必须做成「重复检测→候选生成→用户确认→落全局 + 项目细节过滤」，不能照抄成全自动。

### 2.2 通用记忆产品的 consolidation 机制

材料：`research/b-memory-products.md`（322 行）。要点：

- **共性模式**：触发（写入内同步 / 轮末 / compact 事件 / 去抖 / 容量阈值后台）→ 判定（先召回候选，再让 LLM 对照旧状态/适用范围/时间信息裁决——**相似检索本身不是 consolidation**）→ 更新（ADD/PATCH/NOOP/归档/失效多操作，必须验证提交成功）。
- **mem0**：经典四操作 `ADD/UPDATE/DELETE/NONE`（prompt 直读源码 v1.0.0）；但当前热路径退化为 ADD-only，#5867 实锤冲突记忆并存。**可抄的是「候选集稳定短 ID + LLM 输出显式操作计划 + 确定性执行」的接口形态，不抄 ADD-only 对冲突的放任**。写入合并检索**没有 similarity 阈值**——不能用向量分数充当泛化证据。
- **Letta**：最贴近我们场景。当前 reflection v2 支持跨会话 replay 审阅、重复消解、修订过时记忆（*「Distill reusable patterns, not event transcripts」*）；后台在私有 git worktree 产 commit，父仓库 dirty 停手、merge 冲突 abort 保留重试。但 sleep-time 服务端方案已废弃迁移到客户端 reflection（#3294）——**后台全自动是有设计缺陷被证伪的路径**。
- **Graphiti**：判定金句 `Do NOT infer contradiction from recency alone` / `cannot both be true` 才算矛盾——「重复」「同主题不等价」「矛盾」必须三分。#1728（失效搜索范围过宽、无关事实互相退役）、#1956（候选召回不足被误判为无冲突——**全局既有条目必须单独读入，不能全靠相似检索排名**）。
- **LangMem**：接口形态最佳——`create_memory_manager`（旧状态+新证据→候选新状态，纯转换）与搜索/diff/持久化分离；deletes 默认关。**consolidator 可做成可插拔能力，不必改 v1 存储接口**。#196 实锤「LLM 生成 plan 成功 ≠ 提交成功」（不读 future.result()，异常被吞）。
- **ChatGPT**：Dreaming V3（2026-06-04 官方）证明后台跨对话合成方向成立，但阈值/调度不公开；Simon Willison 实测历史记忆串扰无关任务（*「We're losing control of the context」*）——**泛化必须可关闭、可预览、可回滚、带真实 provenance**。

### 2.3 编码 agent 的项目→全局抽象

材料：`research/c-coding-agents.md`（303 行）。**核心结论：没有任何一个编码 agent 产品实现了「自动识别跨项目重复 → 泛化成全局」**：

- **ZCode**（我们架构的母本）：Dream 只做单项目内 merge/prune，README 非目标清单明文排除跨层 distillation/冲突合并/自动 Dream 触发/PII scanner；feedback #98 用户明确提出「AI 自动建议该配置是否应用到其他项目」，官方只交付项目级即关单——**跨项目泛化是用户提过、官方没敢做的需求**。
- **Windsurf**：global 与 workspace 双层物理都在但**无任何自动提升通道**，全局只能手写；且自动 memories 在新一代 agent 上被废弃——没有置信度/审查/撤销的自动记忆，产品方自己都不敢长期保留。
- **Cursor**：本体无记忆；Continual Learning 插件有 `User Preferences / Workspace Facts` 二分和 12-bullet 上限，但 PR #74（个人记忆误入团队 AGENTS.md 事故修复）5 个月未合并——血淋淋的边界教训。
- **Cline/Roo**：本地 Memory Bank 手动；但官方云端 Roomote 的治理样板最完整：**confident yes 才落盘 + 平台侧敏感 scrub + 夜间二次综合 + operator review + 只追加引用摘要不直接改共享记忆**——pi 的置信门控与 review 流程应对标它。
- **Codex**：AGENTS.md 三层快照（home/thread/repo，`agents_md.rs` 源码直证），零自动沉淀。
- **适配判断**：跨项目泛化是**确认的空白地带，做出来即差异化**；但「跨项目聚类与提升判定」没有先例替我们验证，必须自建：类型约束（只允许 user/feedback 提升）+ 敏感模式过滤（业界本地方案普遍没做）+ pending 默认态。

### 2.4 反面证据与坑

材料：`research/d-pitfalls.md`（519 行，13 条风险）。对杀伤力前三：

1. **误泛化污染全局层**（mem0 #5438/#5587/#5439；graphiti #1728 41% 误判率）——全局层注入所有项目会话，一条误泛化影响所有项目所有会话。
2. **矛盾记忆共存**（mem0 #5867/#4956；graphiti #1956 50 条历史时 0/12 正确）——晋升后必须验证源条目不会与全局重复注入。
3. **跨项目记忆泄漏**（openclaw-supermemory #9 等 4 例）——泛化 = 主动扩大泄露面；Markdown 格式无 sensitivity 标记，必须泛化时过滤。

其余高频坑：去重 TOCTOU（mem0 #6515：判定与提交之间无重新校验）、幻觉幽灵记忆（#4099）、后台整理静默失败（Letta）、无关记忆强制注入、injection via memory（恶意记忆潜伏跨项目浮现——我们的 bidi/`<>` 清理已覆盖注入面，但**泛化写入全局也必须走同一清洗管道**）、合并不可逆（MCB 基准 40.6% 未授权覆写，业界无问责标准）、注入预算失控、LLM 矛盾检测不可靠（非推理模型 1/9）。

**D 报告核心结论**：自动泛化到全局层是本项目风险最高的功能；**至少在全局层写入前加 review gate**。

### 2.5 交叉验证：外部做法 → 本项目接入点（逐条）

| 外部做法 | 本项目现状 | 落地动作 |
|---|---|---|
| CC 凭据拒写 + 索引超限显式报错 | writeFact 无敏感检查；truncateIndex 超限静默截断 | apply 阶段加敏感扫描；全局索引近上限时泛化告警 |
| Letta 提案流（后台产 commit→合入） | 无提案概念 | 新增 proposals 目录（`~/.pi/agent/memory/.consolidation/`），propose 只产提案 |
| LangMem 纯转换接口（旧状态+证据→候选） | 无 | propose 返回结构化候选，LLM 判定在调用会话内完成，**工具零模型依赖不破** |
| Graphiti 三分判定 + 候选不足陷阱 | 无 | 判定 prompt 明写三分；propose 返回「全局既有全部条目」而非 top-k |
| mem0 稳定短 ID + 确定性执行 | 无 | 提案 JSON 用候选短 ID，apply 由代码按 ID 精确执行，LLM 永不直接写路径 |
| Roomote confident yes + scrub + review + 只追加引用 | 无 | review gate + 敏感扫描 + 源条目不删（加 promotedTo 指针） |
| ChatGPT/Simon 教训：可回滚 + provenance | 无版本历史 | journal 文件记录每次 apply；全局事实 frontmatter 记 sourceProjects |
| mem0 #6515 TOCTOU | writeFact 无 CAS | apply 校验源文件 sha256 与提案生成时一致才动 |
| LangMem #196 假成功 | 无 | apply 完成标准=全局正文+全局索引+N 个源标注全部落盘，否则回滚 journal |

## 3. 方案对比与推荐

| | 方案 A：纯 prompt/技能任务 | **方案 B：内置显式触发工具（推荐）** | 方案 C：全自动后台泛化 |
|---|---|---|---|
| 形态 | 写一份「记忆整理」prompt/skill，agent 用现成工具手动泛化 | 新增 `memory_consolidate` 工具（propose/apply 两阶段），机械部分代码化、判定留给会话 agent | agent_settled 定时后台扫描+自动写全局 |
| 改动面 | 零代码（仓库外加 1 个 skill） | index.ts 注册 1 工具；store.ts/paths.ts 新增纯函数；测试 | 动 v1 零模型依赖原则 + 后台调度 |
| 确定性保障 | 无（agent 手写路径，mem0 教训的裸奔形态） | **有**：短 ID 计划 + CAS + journal + 完成验证 | 有 |
| review gate | 靠 prompt 自觉 | **内建于两阶段协议** | 无（证据全反对） |
| 敏感过滤 | 无 | **有**（apply 硬拦截） | 有但自动放行更危险 |
| 风险 | 低（但无护栏） | 低-中（护栏代码化） | **高**（CC 刻意不做、Letta 废弃、误判 20-75%） |

**推荐方案 B**，理由：

1. 用户已拍板「按 CC 结论做显式触发的工具」——B 正是该结论的代码化。
2. A 的零代码优势换来的是无护栏：agent 手写全局文件时凭据过滤/CAS/回滚全靠 prompt 自觉，而 D 报告证明护栏缺失正是业界事故来源。
3. C 被全部四路调研证据反对（CC 刻意不做、ZCode 非目标、Windsurf 废弃、Letta 废弃后台方案、D 报告误判率数据）。
4. B 的机械部分（枚举/粗筛/读全局/确定性落盘）纯代码零模型依赖——**不破坏 v1 原则**；语义判定由调用会话的 agent 完成，与「propose 时模型在场」的 pi 工具形态天然契合。

**为什么不用更简单的替代**（纯 A）：A 可作为 B 的 PoC 先行（见分阶段 P0），但 A 的形态无法提供 D 报告要求的护栏，不能作为终态。

## 4. 详细设计（方案 B）

### 4.1 数据流（改动后）

```
用户在会话中说「整理记忆」/ 定时任务
  └→ agent 调用 memory_consolidate { action: "propose" }
       │  工具（纯代码）：
       │   1. enumerateProjectRoots() 枚举 ~/.pi/agent/memory-projects/*/
       │   2. 解析全部项目事实（parseFact，meta=null 兜底）
       │   3. 机械粗筛候选簇：同 name / description token 重叠（Jaccard≥阈值）/ ≥2 项目
       │   4. 读入全局层全部现有条目（防 Graphiti #1956 候选不足）
       │   5. 候选编号为稳定短 ID（c1, c2…），返回结构化 JSON
       └→ 会话 agent（LLM，判定者）按判定规则逐簇裁决，产出提案：
            { id, decision: promote|merge|noop|conflict,
              globalName, globalType: user|feedback, globalBody,
              sourceProjects[], sourceSha256[], reasoning }
       └→ agent 再次调用 memory_consolidate { action: "propose", proposals: [...] }
            工具落盘 .consolidation/proposals/<ts>.{json,md}（人类可读预览）
            ★ 不写任何记忆层
  ── review gate：agent 向用户展示提案摘要，取得确认 ──
  └→ agent 调用 memory_consolidate { action: "apply", proposalId: "<ts>" }
       │  工具（纯代码，逐项）：
       │   1. 敏感扫描 globalBody（secret/IP/路径模式）→ 命中即拒（除非 force: true）
       │   2. CAS：源文件 sha256 与提案一致才动（mem0 #6515）
       │   3. 写全局事实（自定义写入，绕过 renderFact 的 origin no-op；
       │      frontmatter 加 metadata.sourceProjects/promotedFrom/consolidatedAt）
       │   4. 项目层源条目加 metadata.promotedTo 指针（文件保留，不删）
       │   5. 全部落盘验证（全局正文+索引 upsert+N 源标注）→ 失败按 journal 回滚
       │   6. journal 记录 .consolidation/journal/<ts>.json（回滚依据）
```

LLM 全程只做两件事：裁决候选、起草全局 body 文本。**永远不直接写全局路径**（mem0 稳定短 ID 教训）。

### 4.2 判定规则（写进工具 description + 提案 prompt）

1. **类型门**：只提升 `user|feedback`；`project|reference` 一律 NOOP（项目特定不该上浮——ZCode #98 反例）。
2. **可泛化测试**：抹掉项目特定细节（凭据/路径/IP/环境名）后，剩余表述必须仍可执行且有意义；否则 NOOP。
3. **三分判定**（Graphiti）：等价重复→promote/merge；同主题不等价→NOOP；两条不能同时为真→conflict（报告给用户，不自动裁决）。
4. **与既有全局对照**：语义等价于既有全局事实→merge（更新既有而非新建）；部分重叠→merge 并保留差异说明。
5. **证据门**：sourceProjects ≥2 才允许 promote；单项目一律 NOOP（除非用户显式指示）。
6. **置信门**（Roomote）：拿不准→NOOP，理由写进提案。

### 4.3 文件级改动清单

| 文件 | 改动 | 一句话职责 |
|---|---|---|
| `src/paths.ts` | 新增 | `enumerateProjectRoots()`：列母目录枚举项目层 root；`consolidationDir()`：`.consolidation/` 路径（含 proposals/journal 子目录） |
| `src/store.ts` | 新增导出 | `collectProjectFacts()`（全项目解析+粗筛簇）、`readGlobalFacts()`（全局全量）、`saveProposal()`、`applyProposal()`（敏感扫描+CAS+写入+标注+验证+journal） |
| `src/facts.ts` | 小改 | `renderFact` 增加 `force?: boolean` 选项（apply 需要覆盖已有 origin 文件时显式声明；默认行为不变，**不破坏 writeFact 语义**） |
| `index.ts` | 新增 | 注册 `memory_consolidate` 工具（propose/apply schema + description 教模型两阶段协议与判定规则） |
| `test/store.test.ts` 等 | 新增 | propose/apply 纯函数单测 |
| `README.md` | 更新 | 工具表加一行 + 「记忆整理」使用说明 |

**契约变更**：无对外破坏；`renderFact` 默认行为不变（向后兼容）。注入契约不变（apply 写入只影响新会话快照）。

### 4.4 分阶段实施

- **P0（可选 PoC，0.5 天）**：用现成工具手动跑一次全流程——agent 读全部项目层 MEMORY.md → 产出泛化提案给用户 → 手工 apply。验证判定规则与真实数据质量，产出第一份真实提案样本。
- **P1（最小可验证切片，推荐起点）**：`enumerateProjectRoots()` + `collectProjectFacts()` + `readGlobalFacts()` + propose（无 proposals 落盘，直接返回候选 JSON）+ 单测。**无 LLM、无写入**。会话里 agent 拿到候选即可手动泛化。— **已完成（2026-10-15，feat/memory-consolidate-p1 分支）**：真实数据冒烟产出 25 个候选簇，正确识别 P0 已 promote 的 user-jason-profile（项目层+全局既有 merge 候选）与 09-25 litellm 迁移遗留的全量双层重复（c2-c9），legacy 归档前缀过滤干净。发现并修复 `isLegacy` 漏判 `legacy-` 前缀（原只挡 `legacy-local-`）。
- **P2**：提案落盘 + apply（敏感扫描/CAS/journal/验证）+ `renderFact force` 选项 + 单测。— **已完成（2026-10-15，feat/memory-consolidate-p1 分支续交）**：端到端冒烟验证 promote 路径——全局文件写入（consolidated origin + provenance）+ 索引 pointer + 源条目 promotedTo 标注全部落盘；修复了一个真实 bug（`sha256File` 用 `require('node:crypto')` 在 ESM 静默返回 null，所有 CAS 校验都会误判 TOCTOU——改用顶部 import createHash）。
- **P3**：工具 description 完整判定规则打磨 + README + 真实数据回归跑一轮（人工验收提案质量）。
- **明确不做**：后台自动触发（证据全反对）；embedding 语义聚类（v2 接 qmd 后再评估）；源条目删除（只加指针）。

### 4.5 测试策略

fixtures 构造（全部走 `PI_SCOPED_MEMORY_HOME` 注入临时目录）：
- 两项目同 description 事实 → propose 产一簇
- 同 name 不同 body（同主题不等价）→ 簇标注待判定
- 矛盾对（「用 pnpm」/「禁用 pnpm」）→ 交由 LLM 层，工具不裁决
- 全局已有等价条目 → merge 路径（force 覆盖 + 索引原位替换）
- 敏感命中（body 含 IP/密钥模式）→ apply 拒绝
- 源文件中途被改（CAS 不一致）→ apply 跳过该项并报告
- 写入中途失败 → journal 回滚完整

### 4.6 风险与回滚

| 风险 | 缓解 |
|---|---|
| 误泛化进全局 | review gate + 判定规则 + 敏感扫描；回滚=按 journal 恢复源标注 + 删全局条目（journal 存了写入前状态） |
| 全局索引膨胀触截断 | apply 时检查索引行数/字符数，接近 200 行/25K 上限时拒绝并要求用户先清理（CC 显式报错纪律） |
| LLM 幻觉提案 | propose 只返回真实扫描结果（含原文摘录），提案必须引用候选短 ID，apply 按 ID 校验存在性 |
| 并发写入（多会话同时 apply） | v1 内加进程内锁；跨进程文件锁（`.consolidation/lock`）P2 一并做 |

## 5. 盲区与待拍板

1. **粗筛相似度的阈值与算法**：v1 只能文本 token 重叠，真实数据的误聚/漏聚率未知——P0 PoC 应暴露；语义聚类依赖 v2 qmd。
2. **全局层混合格式**：apply 的索引 upsert 假设 `- [name](name.md)` pointer 格式，而全局层现状是 HTML 注释 + 分组标题混合——upsertIndexLine 的「追加到末尾」行为在混合索引下视觉混乱（不破坏功能）。
3. **sensitivity 标记缺失**：敏感扫描靠正则启发式，必然有误报/漏报；长期可考虑 frontmatter 加 `metadata.sensitivity`，但那是 v1 数据格式扩展，需单独拍板。
4. **review gate 的形态**：会话内确认（轻）vs 独立 `/memory-consolidate` 命令 + 预览 UI（重，属 v2 `/memory` viewer 范畴）——v1 按会话内确认做。
5. **类型门对 merge 的适用性（P3 回归发现，待拍板）**：当前 apply 的类型门拒所有 `project|reference` 类型的提案。但真实数据里 c3/c7/c8/c10–c25 大量是 litellm 09-25 迁移造成的「同一条目在项目层与全局层各存一份」的双层重复（`project` 类型为主）。这些的处置不是「上浮」而是「标注项目层文件为已覆盖」——消除双层重复注入的心智负担，不涉及类型门关心的上浮语义。**设计意图待确认**：类型门应只挡 promote（新建全局事实），还是也挡 merge（仅标注项目层）？当前实现按后者（保守，拒 project 类型的 merge）。若确认前者，apply 的类型门检查应改为「仅 promote decision 受类型门约束，merge/noop 不受」。
