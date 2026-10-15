# 调研 C：编码类 agent 的记忆实现与「项目级 → 跨项目全局抽象」

> 调研日期：2026-10-15
> 调研方法：一手源优先——`gh api` 直读 GitHub 源码/设计文档/issue 原文，playwright-cli 直读官方文档站与官方论坛。
> **工具降级说明**：web-search 技能的 bridge server（127.0.0.1:8923）未运行、技能目录下 `scripts/` 不存在，无法按 SKILL.md 走 search.sh；Google 搜索触发异常流量拦截，Bing 多次返回无关结果。因此实际路径降级为「playwright-cli 直驱官网/论坛 + gh api 直读源码」，结论均来自一手原文，未使用二手介绍文章。docs.cline.biz 两次连接失败、developers.openai.com 超时，相关结论以源码与官方仓库替代证据支撑，下文逐处标注。

---

## 1. ZCode（zai-org/ZCode）——与 pi 同源架构，有「项目内整合」但无跨项目泛化

**一手源**：
- 设计文档：`apps/zcode-cli/docs/design/v2/memory/README.md`（《ZCode Memory 设计 v4》，909 行）
- 源码：`apps/zcode-cli/packages/core/src/{context/sections/memory.ts, memory/extraction.ts, memory/dream.ts}` 等
- 冻结 prompt fixture：`apps/zcode-cli/packages/core/tests/fixtures/memory/{extraction-prompt.md, dream-prompt.md}`
- 用户反馈：github.com/zai-org/feedback #98、#265

### 1.1 机制

Memory 五个能力（README §2 原文列举）：

1. Main Agent 的持久 Memory 文件协议与 provider-visible system section；
2. default-index / semantic-recall 两种互斥检索分支，由 Core 内部唯一常量 `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED=false` 选择，**不暴露任何用户配置**，当前默认走 MEMORY.md 索引注入；
3. 成功 Main turn 后的后台 Extraction；
4. Dream consolidation handler 与 `memory_update`，**当前产品链路不自动触发**；
5. custom agent 的 `user | project | local` 持久 Memory。

存储与文件协议（与 pi 几乎一模一样，pi 即参照它）：

```
<cli-storage-root>/memories/projects/<workspace-key>/memory/
  MEMORY.md
  <fact-name>.md
```

- workspace key = `basename slug + SHA-256 前 16 位`（与 pi 的 `<slug>-<hash16>` 同构）；
- 一事一文件、小写 `.md`、kebab-case slug、`[[wiki-link]]` 关联；
- frontmatter 四类型 `user | feedback | project | reference`（`feedback`/`project` 正文要求 **Why:** 与 **How to apply:**），另含 `metadata.node_type: memory` 与 `originSessionId`；
- `originSessionId` 不由模型生成：Write/Edit 边界仅在缺失时补一次，已有 origin 的文件**原样保留**（不做格式归一化）；
- MEMORY.md 是短索引（`- [Title](file.md) — hook`），上限 **200 行 / 25,000 字符**；
- Main system prompt（`context/sections/memory.ts` 原文）明确噪音边界：*"Don't save what the repo already records (code structure, past fixes, git history, CLAUDE.md) or what only matters to this conversation"*；召回内容带 *"if one names a file, function, or flag, verify it still exists before recommending it"* 的时效警告。

### 1.2 自动提取（agent_settled 双槽 + cursor 语义）

README §6 + `memory/extraction.ts` 源码原文要点：

- **触发**：成功的、非 remote、非 child 的 Main-equivalent turn 结束后 fire-and-forget；headless（`-p/--prompt`、`--target`）固定注入内部 `extractionEnabled=false`；远程 workspace（SSH/WSL/Docker）显式 gate 掉；
- **双槽调度**：只有一个 running slot + 一个 latest-pending slot——running 非空时新 turn 只覆盖 pending，当前任务完成后**只跑最新一次**（无 FIFO、无任务表、无持久恢复）；
- **cursor**：内存中的 durable history message UUID。本段 history 出现 project Memory Write/Edit 则跳过模型并推进 cursor（避免与用户显式写记忆重复劳动）；没有独立的、非 meta、≥3 words 的 user text block 也跳过；cursor 丢失时 prose 检查回扫全量历史；error/abort 不推进 cursor（下次重试），success/no-op/skip 推进；
- prompt 动态注入 `messageCount`（fixture 文案为 *"Analyze the most recent ~2 messages above"*），并明令 *"You MUST only use content from the last ~N messages … no grepping source files, no reading code to confirm a pattern exists, no git commands"*；
- 提取子 agent 工具被收窄：仅 Read/Grep/Glob、只读 Bash、memory root 内 `.md` 的 Write/Edit 与窄 `rm`；最多 **5 个 model turns**，失败不重试；
- prompt 附「Existing memory files」清单（含类型、时间戳），要求 *"update an existing file rather than creating a duplicate"*；无高价值内容时逐字返回 `Nothing to save.`。

### 1.3 Dream（consolidation，但只是项目内整合，不是跨项目泛化）

README §7 + `dream-prompt.md` fixture：

- **触发 gate**：每 10 分钟最多扫描一次；距上次成功 Dream ≥ 24 小时；当前 project 至少有 5 个 transcript mtime 晚于上次整合的 Main-equivalent sessions。**当前没有任何产品入口**：builtin registry 无 `/dream`，CLI/Desktop/mobile 都不新增命令，成功 turn 只调度 Extraction——*"Dream handler、lock、prompt、受限执行和 memory_update 保留，等待产品侧确定 project transcript 隔离形态后再接入触发点"*；
- **lock**：`<memoryRoot>/.consolidate-lock`（mtime <1h 且 PID 存活则 skip；接管需写 PID + read-back 确权；失败恢复旧 lock）；
- **执行**：完整 Main context + 真实工具 + 冻结 prompt，最多 **50 turns**；四阶段 orient → signal → consolidate → prune/index；
- **整合手法**（fixture 原文）：*"Merging new signal into existing topic files rather than creating near-duplicates"*、把相对日期改绝对日期、删除被证伪的事实、裁剪 MEMORY.md 到 200 行/25KB；
- **与项目指令对账**：Dream prompt 有专门一节 *"Reconcile memories against CLAUDE.md"*——记忆与 CLAUDE.md 矛盾时以受版本控制的 CLAUDE.md 为准删除/改写记忆；若记忆明显更新则**不反向改 CLAUDE.md**，只标注 *"contradicts CLAUDE.md — verify which is current"* 列入 summary；
- Dream 改动文件后在下一次 Main 请求注入一次性 `memory_update` attachment 并失效对应 read-state。

### 1.4 项目 → 全局抽象：无

- Main Memory **只有项目层**（`memories/projects/<key>/`），没有与之并列的「用户全局偏好」自动层；
- custom agent persistent memory 有 `user` scope（`<storage.dir>/agent-memory/<agent-key>/`），但那是**按自定义 agent 隔离**的记忆，不是跨项目用户画像，且 README §8 明文 *"不支持 private/team scope"*；
- README §11「明确非目标」逐字列出本轮不实现：*"private/team scope、同步、冲突合并、provenance 或 distillation"*、*"自动 Dream trigger、memory.autoDream 配置"*、*"foreground mutation observer、secret/PII scanner、prompt-injection classifier"*——连**项目内**自动整合都默认关着，跨项目泛化更不在路线上；
- 用户明确提过跨项目诉求：feedback #98《引入四层记忆体系》提出「用户画像记忆（默认用 pnpm 不用 npm 等）」「跨项目记忆漫游（用户主动标记 + AI 自动建议"这个配置是否应用到其他项目？"）」，官方 2026-08 回复仅 *"项目级记忆已上线：v3.7.1 设置可查看、v3.7.4 按项目浏览、会话自动提取沉淀项目记忆"*，随即关单——**跨项目层与自动建议均未交付**。

### 1.5 坑（一手 issue）

- **#265（open）**：远程工作区（SSH/WSL/Docker）后台提取/整合被硬 gate 禁用，只读侧正常；用户抱怨"对话中值得保存的信息不会被自动提取"。安全保守策略的体验代价；
- Desktop app-global `memoryEnabled` 开关**默认 false**，新安装不迁移——自动记忆在产品层面默认不开；
- Settings viewer 被刻意设计成**只读**（无编辑/删除/搜索/导出），官方对"用户直接治理自动记忆"的投入很克制。

### 1.6 对 pi 的可借鉴点（一句话）

双槽 coalescing 调度 + UUID cursor + 「显式写过就跳过」+ 5/50 turn 预算 + 时间/会话数双阈值 gate + 与 AGENTS.md 对账 + 固定 no-op 话术，这套噪音治理组合 pi 可几乎逐字照搬；但**必须清醒：ZCode 的 Dream 是单项目内 merge/prune，跨项目聚类泛化它没做，不能当作"业界已验证"的依据**。

---

## 2. Cursor——本体无记忆产品，跨项目抽象只存在于官方插件的两个 section 标题里

**一手源**：
- 官方文档：cursor.com/cn/docs/rules（2026-10-15 直读全文）
- 官方插件仓库：github.com/cursor/plugins `continual-learning/`（README、SKILL.md、agents-memory-updater.md、hooks.json）
- PR：github.com/cursor/plugins/pull/74（open 未合并）
- 官方论坛：forum.cursor.com 帖 171122、174198（直读原文）

### 2.1 机制

- Cursor 本体的持久上下文是 **Rules 四类**，文档逐字定义：项目规则（`.cursor/rules/*.mdc`，纳入版本控制）、用户规则（Customize → Rules，**全局适用于所有项目**，自由文本）、团队规则（Dashboard 管理，可强制）、AGENTS.md（无 frontmatter 的简易替代，支持根目录与子目录层级）；
- 文档定性原文：*"大语言模型在不同补全之间不会保留记忆。规则在提示级别提供持久、可复用的上下文。"* 即 Cursor **本体不做自动记忆**；
- 项目规则四种激活：Always Apply / Apply Intelligently（模型读 description 自行决定）/ Apply to Specific Files（globs）/ Manual（@提及）；优先级 团队 → 项目 → 用户；
- 只有半自动生成：聊天里 `/create-rule` 让 agent 生成带 frontmatter 的规则文件落盘到 `.cursor/rules`。

### 2.2 唯一的自动沉淀实践：官方 marketplace 插件 Continual Learning

`cursor/plugins` 仓库内 MIT 插件（stop hook + `continual-learning` skill + `agents-memory-updater` subagent）：

- **触发节奏**：stop hook 判定，默认 ≥10 个完成 turn 且距上次 ≥120 分钟且 transcript mtime 前进；trial 模式 3 turns / 15 分钟，24 小时后自动回退默认；env 可覆盖；hook 状态存 `.cursor/hooks/state/continual-learning.json`，增量 transcript 索引存 `continual-learning-index.json`；
- 只扫描 `~/.cursor/projects/<workspace-slug>/agent-transcripts/` 中新增或 mtime 更新的 transcript；
- 产出物固定为 AGENTS.md 两个 section：**`## Learned User Preferences`** 与 **`## Learned Workspace Facts`**，每节最多 **12 bullets**，只写纯 bullet（*"Do not write evidence/confidence tags"*），要求原地更新匹配 bullet、语义去重、排除 secrets/一次性指令；无变化时逐字返回 `No high-signal memory updates.`。

### 2.3 项目 → 全局抽象：有概念雏形，无实现，且修复被搁置

- 「Learned **User** Preferences（跨会话个人偏好）vs Learned **Workspace** Facts（工作区事实）」的二分，正是"项目特定 vs 通用偏好"的产品化表达——**但两者默认写进同一个受版本控制的项目 AGENTS.md，没有任何路由、没有全局文件**；
- 社区发现这是事故：论坛帖 171122（2026-09-09，Cursor 3.19.13）标题即 *"Continual-learning writes personal memory into tracked AGENTS.md in team repos"*，原文称 *"This has been a recurring leak for months"*——个人偏好被追加进团队 AGENTS.md，产生脏 diff 甚至被误提交；每次插件升级换 cache hash 还会抹掉本地补丁；
- 修复方案就是 PR #74（2026-05-23 提出，调研时仍 **open、无维护者合并**）：默认改写 **user-scoped** 路径 `~/.cursor/projects/<slug>/AGENTS.local.md`（Cursor 的 stacked AGENTS.md 加载会自动拾取、永不入库），repo 写入改为 opt-in 且 hook 用 `git check-ignore` 拦截非 gitignored 文件；section 显式路由：User Preferences 只进 user 文件，Workspace Facts 才允许 workspace 文件，受阻时降级到 user 文件的 `## Learned Workspace Facts (local)`；
- 旁证：Cursor 旗下 Grok Bot 已有 *"shared user memory"*（每个 bot 都能读写、每条事实带日期与记录者 bot，论坛 174198 原文），但**没有查看/编辑/导出 UI**，用户只能让 bot  dump 到文件；而 Grok Chat 侧的全局记忆反而是可在设置导入的 MEMORY.md。

### 2.4 坑

- 自动记忆与受版本控制指令文件混用 → 个人偏好污染团队（真实、持续数月、修复无人 review）；
- Cursor 本体不做，导致论坛上充斥第三方 MCP 记忆服务（Memento、Contexo、amem、mnemoverse、Recall 等，2026 年 5–10 月密集发帖）——需求真实但生态碎片化、各自为政。

### 2.5 对 pi 的可借鉴点（一句话）

`User Preferences / Workspace Facts` 二分 + 12-bullet 上限 + cadence（turn×分钟双阈值）+ 增量索引可抄；**PR #74 是血淋淋的边界教训：个人记忆必须物理落在 user-scoped 路径并对 repo 写入做 gitignore gate——pi 的双层目录天然满足，自动泛化写入全局层时仍应保留"绝不触碰项目内受控文件"的红线**。

---

## 3. Cline / Roo Code——本体零记忆，社区 Memory Bank 纯手动分层；云版 Roomote 做到了团队级共享与置信门控

**一手源**：
- github.com/GreatScottyMac/roo-code-memory-bank（README 全文，1.6k★ 量级的事实型仓库）
- github.com/RooCodeInc/Roomote `apps/docs/memory.mdx`（官方产品文档，349 行）
- 对 cline/cline 仓库做代码搜索（`memory in:path`）无记忆模块命中；docs.cline.biz 两次连接失败（chrome-error），**Cline 本体"无内置记忆"结论的直接证据是代码搜索零命中 + 记忆功能全部由第三方仓库/MCP 承载，官方文档页未能亲验，此为降级点**。

### 3.1 机制（Memory Bank 模式）

- Memory Bank 是社区 prompt 模式，不是产品功能：项目根放 `memory-bank/`，固定六个手工 markdown：
  - `activeContext.md`（当前会话状态/目标）、`decisionLog.md`（技术决策与理由）、`productContext.md`（项目概览）、`progress.md`（进度）、`projectBrief.md`（初始需求，可选）、`systemPatterns.md`（重复模式与标准，可选）；
- 驱动方式：把 `memory_bank_strategy_<mode>.yml` 贴进 Roo/Cline 各模式（Architect/Code/Ask）的 custom instructions，由 prompt 指示 agent 在"项目结构变化/功能更新/文档更新"等触发点**实时改写这些文件**；启动时先扫描 `memory-bank/` 目录；
- 全部文件位于**项目仓库内**（随 git 共享给团队），没有全局/用户层，没有自动提取管线、没有 cursor、没有模型判定——连"更新触发"都是靠系统提示词里的自然语言指令。

### 3.2 项目 → 全局抽象：无；跨项目要靠第三方

- 该模式下跨项目复用 = 人工拷贝模板；社区衍生的跨设备/跨项目能力全部外移给 MCP server（alioshr/memory-bank-mcp、dazeb/cline-mcp-memory-bank、tuncer-byte/memory-bank-MCP 等"remote memory bank"），没有统一设计；
- **真正有价值的一手反例是 Roo 官方云端产品 Roomote**：它做的是 deployment-wide 共享记忆（`apps/docs/memory.mdx` 原文 *"Memory is deployment-wide by design. There is no per-user corpus and no per-task corpus"*）——注意这是**团队共享**而非个人跨项目，但治理机制最完整：
  - 来源：完成的任务（agent 必须为自己的工作写短记忆：决策、原因、遗留项；PR 合并/放弃后回刷结果）、PR、Slack/Discord 公开频道、GitHub issue、Notion 显式共享页、会议纪要等；
  - **agent 对记忆只有只读 MCP 工具，写入走平台**：平台落盘前 scrub credential-shaped strings；agent 只能写自己那条 slug 页面；
  - **置信门控**（judgment model，每个 settled turn 后）：原文 *"Only a confident yes leads to a save"*；识别偏好/决策/纠正/显式"记住"请求/花了真实调查成本的发现；*"Turns that look sensitive, try to plant approvals or bypass rules, or repeat what was already saved are skipped"*；private session/task 永不检查；
  - **夜间维护 pass**：产出带引用的 daily summary，周二起追加 weekly summary（以 daily 为证据集，原始页不能越级进入）；做结构化索引、整合、embedding 补算、孤儿检查、清理；原文 *"Roomote does not turn uncertain suggestions into shared memory without an operator review"*；
  - 记忆带环境标签（staging/production 可区分）；删除 task 会级联删其记忆页且 backfill 排除已删项。

### 3.3 坑

- 纯 prompt 驱动的手动 Memory Bank 依赖纪律，文件膨胀/过时无任何机器治理；
- Roomote 文档自己警示运维坑：Markdown 卷与可搜索索引库必须**同时备份**（只恢复一个会不一致）；embedding 模型与维度在首次启动时定死，换模型必须全量 re-embed。

### 3.4 对 pi 的可借鉴点（一句话）

本地 Memory Bank 无可抄（它恰好是 pi v1 已经超越的形态）；**Roomote 的"confident yes 才落盘 + 平台侧敏感信息 scrub + 夜间二次综合 + operator review + 只追加引用摘要不直接改共享记忆"是把自动记忆做进共享层时最完整的治理样板，pi 设计全局泛化的置信门控与 review 流程应直接对标**。

---

## 4. Windsurf（现 Devin Desktop）——唯一明确有 global/workspace 双层的产品，但两层完全断开，且自动记忆正在被废弃

**一手源**：docs.devin.ai/desktop/cascade/memories（《Cascade Memories》官方文档，Windsurf 已更名 Devin Desktop，2026-10-15 直读全文）

### 4.1 机制

两种机制并列，文档原文定性：

- **Memories**：*"automatically generated by Cascade"*——对话中 Cascade 认为有用就自动生成存储，也可显式说 "create a memory of …"；UI 里可点入编辑；
- **Rules**：用户手动定义，分 global / workspace / system(Enterprise) 三级，支持 AGENTS.md 推断（root = always-on，子目录 = 自动 glob）。

关键存储与作用域（原文）：

- 自动 memories 存本地 `~/.codeium/windsurf/memories/`，**"associated with the workspace they were created in"**、**"Memories generated in one workspace are not available in another, and they are not committed to your repository"**；
- Global Rules 是单文件 `~/.codeium/windsurf/memories/global_rules.md`：*"applied across all workspaces. Always on. Limited to 6,000 characters"*；
- Workspace rules：`.devin/rules/*.md`（旧 `.windsurf/rules/` 兜底），每文件 12,000 字符，四种 trigger：`always_on / model_decision / glob / manual`；Enterprise system rules 走 OS 目录（macOS `/Library/Application Support/Devin/rules/`）只读下发。

### 4.2 项目 → 全局抽象：明确没做

- 自动 memories **按 workspace 隔离、无任何跨 workspace 提升通道**；全局层（global_rules.md）**只能手写**，系统不会把 workspace 里反复出现的记忆泛化上去——双层物理共存、语义断开；
- 文档主动给自动记忆降权，原文建议：*"For knowledge you want Cascade to reliably reuse, write it as a Rule or add it to AGENTS.md … Rules are version-controlled, shareable with your team, and give you explicit control over activation"*，memories 只配 *"remember one-off facts"*；
- 更强的信号：文档顶部注明 **Memories 仅对 legacy Cascade agent 生效，新默认的 Devin Local agent 不持久化 memories**，依赖项要跑 *"Open Cascade Migration Wizard"* 迁到 Skills——**厂商在新一代 agent 上用"手动 Skills"取代了自动记忆，这是全阵营对自动记忆噪音问题最保守的产品裁决**。

### 4.3 坑

- 自动记忆不可跨项目 → 用户在每个项目重复被"记住"同一偏好，价值随项目数稀释；
- 全局规则有硬上限（6,000 字符）且永远全量注入，没有索引/召回分层，无法承载事实库。

### 4.4 对 pi 的可借鉴点（一句话）

Windsurf 是"有双层但不做自动泛化"的最干净官方标本——**它证明光有目录分层不会产生泛化，这正是 pi 要填的空白；同时它的退缩（auto memories 降级为 one-off、新 agent 直接砍掉）提醒：没有置信度/审查/撤销机制的自动记忆，产品方自己都不敢长期保留**。

---

## 5. Codex CLI（openai/codex）——AGENTS.md 层级发现做到极致，但记忆侧零自动沉淀

**一手源**（`gh api` 直读 main 分支源码）：
- `codex-rs/core/src/agents_md.rs`（562 行，文件头注释即完整规范）
- `codex-rs/core/src/agents_md_manager.rs`（204 行）
- `codex-rs/codex-home/src/instructions/mod.rs`（113 行）
- `docs/agents_md.md`（仅跳转 developers.openai.com，该站抓取超时，未引用其内容）

### 5.1 机制（纯静态层级发现）

`agents_md.rs` 文件头注释原文：

1. 从 cwd 向上找 project root marker（默认 `.git`，可配 `project_root_markers`；空列表禁用上行遍历）；
2. 收集从 project root 到 cwd（含）路径上的**每一个** AGENTS.md，按该顺序拼接，分隔符固定 `\n\n--- project-doc ---\n\n`；
3. **不越过 project root**；
4. 可配 `project_doc_fallback_filenames`；总字节受 `project_doc_max_bytes` 预算约束（沿拼接顺序递减扣减）；
5. active project 处于 untrusted 时跳过项目指令。

用户/全局层：`codex-home/instructions/mod.rs` 的 `CodexHomeUserInstructionsProvider` 从 codex home 读 **`AGENTS.override.md` 优先、`AGENTS.md` 次之**（本地个人覆盖，注释直接称 "global AGENTS.md"）；`AgentsMdManager` 把 **global（host 提供）+ thread + repository** 三层解析成一个校验过的快照，refresh 串行化，子 agent 继承已应用快照（thread provider 可显式 opt-in 共享）。

### 5.2 自动生成/沉淀：完全没有

全仓库没有 memory extraction、没有会话后写盘、没有从会话学习 AGENTS.md 的任何代码路径；用户级 `~/.codex/AGENTS.md` 纯手写。`docs/agents_md.md` 全文只有一句跳转链接。

### 5.3 坑

- 无记忆能力本身不算坑，但多层 AGENTS.md 靠顺序拼接 + 分隔符，冲突时只靠顺序隐含优先级（不像 Cursor Rules 显式声明团队>项目>用户）。

### 5.4 对 pi 的可借鉴点（一句话）

可抄的是**工程约定**：root→cwd 逐层级发现与拼接顺序、`AGENTS.override.md` 这类"本地个人覆盖文件"命名约定、untrusted 项目不读指令的 trust gate、字节预算跨层递减；记忆机制层面零参考——它代表"纯 AGENTS.md 教派"的边界。

---

## 6. 快速扫描

### 6.1 Aider——CONVENTIONS.md 纯手动

一手源：`Aider-AI/aider` 仓库 `aider/website/docs/usage/conventions.md` 原文：用户手写一个 markdown（如 CONVENTIONS.md，例："Prefer httpx over requests"），用 `/read`（只读、可吃 prompt cache）或 `--read` 加入，或在 `.aider.conf.yml` 配 `read:` 永久加载；另有社区众包 conventions 仓库。**无任何自动提取、无项目/全局分层、无沉淀**。对 pi 的借鉴：只读标记 + prompt cache 友好（pi 的 session_start 冻结注入已具备同样性质）。

### 6.2 OpenHands——未取得一手证据，明确存疑

两次尝试（代码搜索 microagents、`.openhands/microagents` 目录）均 404，按收敛要求停止。公开认知里 OpenHands 有 micro-agents/knowledge 机制，但**本次未读到原文，不作事实断言**；如需引用应后续补一手调研。

---

## 7. 总结：编码 agent 阵营在「跨项目泛化」上的整体现状

### 7.1 做了什么

1. **项目内自动提取已成为头部产品/插件的标配模式**，且设计高度趋同：
   - 触发：成功 turn 后异步 fire-and-forget（ZCode）/ stop hook + turn×时间双阈值（Cursor 插件 10 turns·120min；ZCode Dream 24h·5 sessions）；
   - 防重：增量 cursor（ZCode 内存 UUID）或增量 transcript 索引（Cursor 插件）；用户/模型已显式写过的段跳过模型；
   - 预算：提取子 agent 5 turns、整合 50 turns、section ≤12 bullets、索引 ≤200 行/25KB；
   - 去重：先列出现有文件清单，要求"原位更新而非新建重复文件"，无内容时固定话术 no-op；
   - 权限收窄：提取上下文只给只读工具 + memory 目录内写权限，禁止网络/MCP/Agent。
2. **"项目内整合（consolidation）"有完整但保守的实现**：ZCode Dream 是唯一产品级范本（lock 确权、四阶段、与 CLAUDE.md 对账、一次性 memory_update），但默认不触发、无产品入口；Roomote 夜间 daily/weekly 综合是云端团队版范本。
3. **层级化手动指令全面普及**：Cursor Rules（团队/项目/用户）、Windsurf Rules（system/workspace/global）、Codex AGENTS.md（home/thread/repo 三层快照）——"全局用户指令层"作为概念人人都有。
4. **安全/边界设计趋严**：headless 与远程 workspace 默认关提取（ZCode）、个人记忆写 user-scoped 路径并 gitignore gate（Cursor PR #74）、平台侧 scrub 凭据 + 注入式内容跳过（Roomote）、untrusted 项目不加载指令（Codex）。

### 7.2 普遍没做什么（核心结论）

1. **没有任何一个编码 agent 产品实现了"自动识别跨项目重复记忆 → 泛化成全局事实"**：
   - ZCode：只有项目记忆，Dream 只在单项目内 merge/prune，非目标清单明文排除跨层 distillation/冲突合并；用户在官方反馈里明确提出"AI 自动建议该配置是否应用到其他项目"，官方只交付了项目级即关单；
   - Windsurf：global 与 workspace 两层物理都在，但**没有任何自动提升通道**，全局只能手写，且自动 memories 在新一代 agent 上被废弃；
   - Cursor：本体不做记忆；最接近的插件只产出 "User Preferences / Workspace Facts" 两个 section 标题，实际同写一个项目文件，连 user-scoped 落盘的修复 PR 都 5 个月没合并；
   - Cline/Roo：本地靠手动 Memory Bank（项目内），跨项目外移给碎片化第三方 MCP；
   - Codex/Aider：零自动沉淀。
2. **没有现成的"跨项目去重/合并"算法或产品可抄**——最接近的是 ZCode 单项目内"语义相似 bullet 去重 + 原位更新"和 Roomote 跨源 nightly synthesis（带引用、走 operator review），两者都没有"同一偏好在 N 个项目复现 → 置信度累积 → 提升为全局"这一步。
3. **自动记忆的治理普遍只做到"条目级克制"，没做到"知识生命周期"**：能看到的手段都是上限/去重/只读 viewer；真正做置信门控（confident yes）、敏感 scrub、人工评审、可回滚的只有团队云端产品 Roomote——而它的前提是有平台侧写入门禁，不是本地文件直写。

### 7.3 对 pi consolidation 设计的直接含义

- pi 规划的「枚举全部项目层 → 重复/相似聚类 → 泛化写全局 user/feedback」在编码阵营是**确认的空白地带**，做出来即差异化；ZCode 的 Dream 四阶段与 lock、Roomote 的 confident-yes + 夜间综合 + review、Cursor 的 cadence/增量索引/12-bullet 是可组装的零件，但"跨项目聚类与提升判定"这一步没有先例替我们验证；
- 业界证据一致指向**默认保守**：自动整合默认关闭（ZCode Dream、Windsurf 新 agent）、默认只写 user-scoped（Cursor PR #74）、不确定不入库（Roomote）。pi 方案应让泛化产物默认进入 **pending/待确认** 而非静默改写全局索引，并保留来源项目数、原文出处与一键回滚——全局层污染面是所有项目会话，这与 Roomote "不把不确定建议变成共享记忆" 的教训同构；
- 必须显式处理两条已被真实事故验证的红线：**个人偏好不得落入受版本控制的项目文件**（Cursor 事故）、**项目特定事实（发布窗口、服务器 IP）不得误提升为通用偏好**（ZCode issue #98 的反例与 pi 项目层已含凭据的现状）——泛化候选需要类型约束（只允许 user/feedback 提升）与敏感模式过滤，而业界本地方案普遍没做 secret/PII scanner（ZCode 明确列为非目标），这是 pi 需要自建的部分。

---

## 附：关键 URL 清单

**ZCode**
- 设计文档：https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/design/v2/memory/README.md
- 提取源码：https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/extraction.ts
- Main 记忆 prompt：https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/context/sections/memory.ts
- 提取 prompt fixture：https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/tests/fixtures/memory/extraction-prompt.md
- Dream prompt fixture：https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/tests/fixtures/memory/dream-prompt.md
- 用户四层记忆诉求（官方仅交付项目级）：https://github.com/zai-org/feedback/issues/98
- 远程工作区提取被禁用：https://github.com/zai-org/feedback/issues/265

**Cursor**
- Rules 官方文档：https://cursor.com/cn/docs/rules
- Continual Learning 插件：https://github.com/cursor/plugins/tree/main/continual-learning
- user-scoped 修复（open 未合并）：https://github.com/cursor/plugins/pull/74
- 个人记忆污染团队 AGENTS.md 事故：https://forum.cursor.com/t/continual-learning-writes-personal-memory-into-tracked-agents-md-in-team-repos/171122
- Grok Bot shared user memory 无管理 UI：https://forum.cursor.com/t/grok-bot-no-way-to-view-or-export-shared-user-memory-unlike-grok-chats-memory-md/174198

**Cline / Roo**
- Memory Bank 模式：https://github.com/GreatScottyMac/roo-code-memory-bank
- Roomote 共享记忆治理（confident yes / scrub / nightly synthesis）：https://github.com/RooCodeInc/Roomote/blob/main/apps/docs/memory.mdx

**Windsurf / Devin Desktop**
- Memories & Rules 官方文档：https://docs.devin.ai/desktop/cascade/memories

**Codex CLI**
- AGENTS.md 发现源码：https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs
- 三层快照管理：https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md_manager.rs
- 用户级 ~/.codex/AGENTS.md：https://github.com/openai/codex/blob/main/codex-rs/codex-home/src/instructions/mod.rs

**Aider**
- CONVENTIONS.md：https://github.com/Aider-AI/aider/blob/main/aider/website/docs/usage/conventions.md
