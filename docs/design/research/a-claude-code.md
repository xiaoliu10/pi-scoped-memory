# Claude Code 记忆机制逆向调研（对照 pi-scoped-memory 泛化功能设计）

- 调研对象：`@anthropic-ai/claude-code@2.1.300`（本机 brew 安装，2026-10-15）
- 方法：本地逆向为主（安装包内嵌 JS 直读 + CHANGELOG + issue 原文 + 真实数据目录只读观察），官方文档 code.claude.com/docs/en/memory 网页原文为辅
- **重要方法说明（影响后续复现）**：本机安装已不是"几 MB 的 minified cli.js"，而是 **238MB Bun 单文件可执行 `bin/claude.exe`**（Mach-O arm64）。其中嵌着可读 JS 源：按 `\0` 切分字节流、筛出含 `// @bun @bytecode` 标记的块（共 2419 个 source block），再用 python `re.finditer` 定位符号/字符串即可拿到原始上下文，远比 `rg -o` 准。binary string table 与 JS 源混在同文件，直接 rg 会把两者混淆（本报告所有片段均来自 JS 源块）。
- 所有引用均注明来源：内嵌 JS 原文 / CHANGELOG / GitHub issue / 官方文档 URL。

---

## 1. CLAUDE.md 分层体系

### 1.1 四层 + 路径（官方文档表格 + 二进制内 `function A5` 互证）

来源：https://code.claude.com/docs/en/memory 「Choose where to put CLAUDE.md files」表格（网页全文抓取），与内嵌 JS：

```js
function A5(e){switch(e){
case"User":return Ye(ve(),"CLAUDE.md");          // ~/.claude/CLAUDE.md
case"Local":return Ye(ke(),"CLAUDE.local.md");   // <cwd>/CLAUDE.local.md
case"Project":return Ye(ke(),"CLAUDE.md");       // <cwd>/CLAUDE.md
case"Managed":return Ye(UA(),"CLAUDE.md");       // /Library/Application Support/ClaudeCode/CLAUDE.md (macOS)
case"AutoMem":return GG()}}                      // auto memory 的 MEMORY.md
function ije(){return Ye(UA(),".claude","rules")}     // managed rules 目录
function aje(){return Ye(ve(),"rules")}               // ~/.claude/rules/（用户级 rules）
```

文档原文要点（引用）：
- 加载顺序（broadest → most specific，后加载者靠后出现）：
  1. **Managed policy**：`/Library/Application Support/ClaudeCode/CLAUDE.md`（Linux `/etc/claude-code/CLAUDE.md`，Windows `C:\Program Files\ClaudeCode\CLAUDE.md`）
  2. **User**：`~/.claude/CLAUDE.md`（另有 `~/.claude/rules/` 用户级 rules）
  3. **Project**：`./CLAUDE.md` **或** `./.claude/CLAUDE.md`（两者都加载；无 CLAUDE.md 时才读 `AGENTS.md`，可用 Project instructions 设置改为 both）
  4. **Local**：`./CLAUDE.local.md`（append 在同目录 CLAUDE.md 之后）
- 目录链：cwd 及其所有祖先目录的 CLAUDE.md/CLAUDE.local.md 在**启动时全量加载**；**子目录**的 CLAUDE.md **按需加载**（"once Claude reads, writes, or edits another file in that subdirectory"，包括被计为 read 的 cat/head）。
- 优先级语义：**没有覆盖（override），只有拼接**——"All discovered files are concatenated into context rather than overriding each other… content is ordered from the filesystem root down to your working directory… instructions closer to where you launched Claude are read last"；冲突时 "Claude may pick one arbitrarily"。
- 去重/排除机制：
  - `claudeMdExcludes`（任意 settings 层，数组跨层合并）：glob/绝对路径排除 User/Project/Local 三类文件；**Managed 不可被排除**（内嵌 JS 原文："Only applies to User, Project, and Local memory types (Managed/policy files cannot be excluded)"）。排除匹配同时比对 symlink 链接路径与目标路径（≥2.1.239 行为）。
  - `@path` import 语法：递归最多 **4 跳**（JS 常量 `bur=5` 对应深度上限，`function rIo` 解析 `@path` 与 `@#anchor`）；项目级文件引用工作目录外的"external import"需**首次批准对话框**（防供应链注入）；用户级文件（~/.claude/CLAUDE.md、~/.claude/rules/）默认信任不弹窗（Cowork 桌面会话除外）。
  - `.claude/rules/*.md`：无 `paths:` frontmatter → 启动加载（与 .claude/CLAUDE.md 同优先级）；有 `paths:` → 按文件匹配**按需加载**（paths 预算 1000 展开模式/4MiB）。rules 支持 symlink 跨项目共享，目录外链接同样走 external-import 批准。
  - 大小限制：单 CLAUDE.md **4 MiB** 上限（超限整文件跳过，JS：`skipping ${e}: not a regular file or exceeds ${UW} byte limit`，`UW` 即 4MiB 档）；建议 <200 行。HTML 块注释注入前剥离。

### 1.2 对 pi 的适配判断
- pi 的「全局 + 项目」两层与此同构，可抄其三点：① **拼接不覆盖 + 后加载靠后**的优先级语义（比"优先级覆盖"更安全）；② **子目录按需加载**（pi 目前无，可作为项目层 rules 的懒加载设计）；③ `claudeMdExcludes` 式排除（企业 monorepo 真实需求）。
- 不必抄 Managed policy 层（pi 无企业管控场景）；AGENTS.md 兼容逻辑值得留意（pi 读 CLAUDE.md 系，未处理 AGENTS.md fallback）。

---

## 2. 自动记忆：存在，双通道（in-loop 直写 + 后台提取）

### 2.1 auto memory 概览（默认开启）

官方文档原文（https://code.claude.com/docs/en/memory 「Auto memory」节）：
> "Auto memory lets Claude accumulate knowledge across sessions without you writing anything. As it works, Claude saves four kinds of notes for itself… Claude records the kind as a type field in the memory file's frontmatter: **user / feedback / project / reference**"
> "Claude skips anything it can derive from the codebase… It also skips anything your CLAUDE.md files already say."
> "Auto memory is **on by default in local sessions**."
> "Each project gets its own memory directory at `~/.claude/projects/<project>/memory/`. The <project> path is derived from the git repository, so **all worktrees and subdirectories within the same repo share one auto memory directory**."
> "MEMORY.md acts as an index… **The first 200 lines of MEMORY.md, or the first 25KB, whichever comes first, are loaded at the start of every conversation.**"
> "Claude Code doesn't load topic files at startup. Claude reads them **on demand using its standard file tools**."
> "Claude Code deletes old session transcripts after the cleanupPeriodDays retention period, but **excludes the memory files in the memory directory from that retention sweep**."
> 写文件时自动补 frontmatter `modified` ISO 时间戳（≥2.1.214，"never adds frontmatter to a file that has none"）。

二进制常量直证（内嵌 JS，chunk-xa…）：
```js
var Xu="MEMORY.md", AF=200, tae=25000, WPr=4*tae, RIe=200, nae=4096;
var Yg="memory", KR="MEMORY.md";
// 默认路径：xo(T5(),"projects",b,"memory")+…，b = Vv(canonicalWcRoot 或 projectRoot) sanitized
// defaultKey: working_copy(经 worktree 归并) > git(Ys) > project_root
```
`autoMemoryDirectory` 设置可改路径（"Supports ~/ prefix… **Ignored if set in projectSettings (checked-in .claude/settings.json) for security**. When unset, defaults to ~/.claude/projects/<sanitized-cwd>/memory/."——内嵌 zod describe 原文；`Qg()` 读取顺序 policySettings → flagSettings → localSettings/projectSettings → userSettings，且 repo 提供的路径在 `permissions.blockReadsOutsideWorkingDirectories` 下完全不加载不写入）。开关：`autoMemoryEnabled`（settings）/ env `CLAUDE_CODE_DISABLE_AUTO_MEMORY`（JS `Xg()`：off/forced_on/unset 三态）/ `/memory` 对话框 toggle（后台会话不能开只能关，CHANGELOG 2.1.285）。

### 2.2 通道 A：in-loop 直写（主提示词驱动，无专用工具）

内嵌 JS（memory 载入提示词生成函数 `yo(e,n,…)`，即注入会话的 "# auto memory" 指令）原文摘录：

```
You have a persistent, file-based memory system at `<dir>`. This directory already exists —
write to it directly with the Write tool (do not run mkdir or check for its existence).
You should build up this memory system over time so that future conversations can have a
complete picture of who the user is, how they'd like to collaborate with you, what behaviors
to avoid or repeat…
If the user explicitly asks you to remember something, save it immediately as whichever type
fits best. If they ask you to forget something, find and remove the relevant entry.

## How to save memories
Saving a memory is a two-step process:
**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:
**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory —
each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`.
It has no frontmatter. Never write memory content directly into `MEMORY.md`.
`MEMORY.md` is always loaded into your conversation context — lines after 200 will be truncated…

## Memory and other forms of persistence
- When to use or update a plan instead of memory: …
- When to use or update tasks instead of memory: … memory should be reserved for information
  that will be useful in future conversations.
```

触发：模型自主判断 + 用户显式 "remember…"（文档："When you ask Claude to remember something… Claude saves it to auto memory"；"Claude doesn't save something every session. It decides what's worth remembering based on whether the information would be useful in a future conversation."）。UI 会显示 "Saved 2 memories" / "Recalled 2 memories"。

### 2.3 通道 B：后台 post-turn 提取（默认关，env 门控）

内嵌 JS（`extractMemories` 函数族）原文关键句：

```js
if(a.CLAUDE_CODE_POST_TURN_MEMORY && rXe()===null)
  t("[extractMemories] CLAUDE_CODE_POST_TURN_MEMORY is set but CLAUDE_CODE_POST_TURN_MEMORY_CONFIG
     is missing or invalid; the pass is off")
// 跳过条件（事件名直证）：
tengu_extract_memories_skipped_direct_write   // "conversation already wrote to memory in this range"
tengu_extract_memories_skipped_no_prose       // "no user prose since last extraction"
tengu_extract_memories_skipped_permission_rule// 权限规则会拒绝 memory 写入
// 节奏：everyNTurns（rXe() 配置，GrowthBook tengu_bramble_lintel 兜底=1）、idle_flush 定时器、
// 失败/被打断时游标不动 → 下次 pass 重看同段对话
// UI 标签：cqn={dream:"Background memory consolidation",extract:"Background memory extraction"}
```

即：**后台提取 = 独立小 pass 重读增量对话 → 用同一套 frontmatter 格式写 topic 文件 + 更新索引**，与主对话写记忆互斥（同区间已写过就跳过）。本地 CLI 默认不开（`CLAUDE_CODE_POST_TURN_MEMORY` env 显式开）， Cowork/remote 侧另有 `createLaptopExtractRunner`。

### 2.4 对 pi 的适配判断
- **格式完全同源**：pi 的「一事一文件 + frontmatter + MEMORY.md 一行索引 + 200 行/25KB 索引截断」就是这套（含四种 type 名）。上限常量 AF=200 / tae=25000 可直接对齐。
- 可抄：① 提示词的两步写法与"索引不是记忆、永不直写 MEMORY.md"约束（pi 现在缺这条纪律）；② "codebase 可推导的不存、CLAUDE.md 已有的不存" 的负面清单；③ `modified` 时间戳自动维护 + 不可见字符/伪 tag 清洗（2.1.284：'invisible characters and tags that imitate Claude Code's own markup are neutralized in MEMORY.md and recalled memory notes'——prompt injection 防护，pi 应抄）。
- 后台提取对 pi v2（引入模型依赖后）是好参照：**按增量游标跑、与 in-loop 写互斥、失败不推进游标、no-prose 跳过**都是实战过的坑位设计。

---

## 3. 跨项目/全局泛化：**没有自动机制**（关键结论）

### 3.1 证据

1. **dream（后台整合）只作用于单项目目录**。内嵌 JS dream 提示词原文（`# Dream: Memory Consolidation`）：
   ```
   You are performing a dream — a reflective pass over your memory files. Synthesize what
   you've learned recently into durable, well-organized memories so that future sessions can
   orient quickly.
   Memory directory: `${e}`      // 单一目录
   Session transcripts: `${r}` (large JSONL files — grep narrowly, don't read whole files)
   ## Phase 1 — Orient: ls the memory directory… Read `MEMORY.md`… Skim existing topic files
   ## Phase 2 — Gather recent signal: 1. Existing memories that drifted… 2. Transcript search…
   ```
   其 team 变体明文禁止跨层自动提升：
   > "**Do not promote personal memories into `team/` during a dream** — that's a deliberate choice the user makes via `/remember`, not something to do reflexively."
   对 CLAUDE.md 也只"标注不改"：dream 中发现 memory 与 CLAUDE.md 矛盾 → "do NOT edit CLAUDE.md during a dream. Annotate the memory with 'contradicts CLAUDE.md — verify which is current' and list it in your summary"。
   开关：`autoDreamEnabled`（settings describe："Enable background memory consolidation (auto-dream). When set, overrides the **server-side default**"），默认由服务端 GrowthBook `tengu_onyx_plover` 控制；/config 有 "Auto-dream" toggle（`tengu_auto_dream_toggled` 事件）。**dream 的对象始终是当前项目的 memory 目录（含 team/ 子目录），不读其他项目，更不写 ~/.claude 全局**。

2. **官方文档明文机器本地、无跨项目层**：
   > "Auto memory is **machine-local**… Files are not shared across machines or cloud environments."
   整个 memory 页没有任何"项目记忆泛化到全局"的机制描述。

3. **各"共享层"都是独立存储，不是泛化管道**（内嵌 JS 作用域函数 `Xkr` 原文）：
   ```js
   function Xkr(e){switch(e.scope){
   case"user":   return xi();      // 当前项目 auto memory 目录
   case"account":return SPo();     // ~/.claude/memory/personal（账号记忆，跨项目，由账号服务同步）
   case"team":   return Kt(xS(),e.mount)…}}  // team 挂载存储（CLAUDE_MEMORY_STORES，服务端同步）
   ```
   accountMemory / team memory（`CLAUDE_MEMORY_STORES` env）/ org memory（`orgMemoryRead/orgMemoryWrites`，`/v1/code/memory/` 服务，issue #48465 提到 MCP 后端替换）都存在，但都是**用户/组织显式选择加入的服务端存储**，没有"从项目记忆自动总结上浮"的代码路径。

4. **结论**：Claude Code 的项目→全局知识流动是**纯手工**：用户把通用规则手写进 `~/.claude/CLAUDE.md` 或 `~/.claude/rules/`，或在 dream/对话中让模型改写；工具本身不做自动泛化。issue #87027（open）"**Account-level sync for user config and auto memory**" 佐证连全局 auto memory 都还没有。

### 3.2 对 pi 的适配判断
- pi 要做的「跨项目重复记忆自动泛化成全局」是 Claude Code **明确没做、且其设计哲学刻意不自动化**的点（dream 连 team 提升都要 `/remember` 显式触发，防"reflexive promotion"）。这既是机会（pi 可以做出差异化），也是警示：CC 团队显然判断**自动上浮风险 > 收益**（错误泛化会污染所有项目）。建议 pi 泛化必须带**确认门**（候选→用户批准→落全局），至少默认如此。

---

## 4. memory 工具面

### 4.1 本地 auto memory：无专用 tool

- 内存取/存靠**通用 Read/Write/Grep/Glob**（提示词明文 "write to it directly with the Write tool"；文档 "Claude reads them on demand using its standard file tools"）。UI 侧的 "Recalled/Saved" 计数（`memoryReadCount/memorySearchCount/memoryWriteCount`，`memoryReadFilePaths`）是对**写路径的识别统计**，不是独立工具。
- 写入防护（内嵌 JS 原文）：
  - `"auto memory files are allowed for writing"`（`Uin`）——写权限按路径前缀判定 `HX()`（路径必须在 auto memory 目录下且非 symlink 逃逸）。
  - 索引超限：`"The memory store has reached its memory limit"` / `"MEMORY.md content exceeds the prompt-index cap"` / CHANGELOG 2.1.210 "Memory writes that leave a MEMORY.md index over its read limit now produce an explicit error instead of silent truncation"。
  - 安全检查：`"The server's safety check rejected a memory file's content"`、凭据检测 "memory content appears to contain a credential or API key; remove it before writing"。

### 4.2 远程/组织侧：有 memory_list / memory_read / memory_write 三工具

内嵌 JS 常量（chunk 原文）：
```js
var cb="memory_list", Vf="memory_read", Hc="memory_write", OCs=["memory_list","memory_read","memory_write"];
```
服务路径校验 `Li="/v1/code/memory/"`，store kind 有 `grouping/grouping_root/silo`；远程 store 的读取描述："Id of the memory store to read from (call … with no arguments to see the stores available in this session)"、"Path of the memory document to read (e.g. /MEMORY.md)"。**注意这组工具服务的是 accountMemory/team/org 云端存储，不是本地 auto memory 目录。** SDK 侧另有 `project_memory_list` / `project_memory_read`（sdk-tools.d.ts L751-762：control-request，用于宿主读记忆列表/内容）。

### 4.3 命令与设置面
- `/memory`：local-jsx 对话框，`{type:"local-jsx",name:"memory",description:"Edit CLAUDE.md files and memory settings"}`——列出各级 CLAUDE.md/CLAUDE.local.md/rules + auto memory 文件夹（含记忆清单：索引在前、按 mtime 排序、scan 上限 **200** 条），可 toggle Auto-memory / Auto-dream，可开目录。`pause-memory`（别名 memory-pause/toggle-memory）暂停本会话记忆。`/doctor prompt-audit` 审计指令文件。
- 主题文件注入子代理：默认不注入（"The main conversation's auto memory isn't loaded into subagents; the exception is a fork"）；子代理可用 `memory` 字段启用自己的目录（issue #77261 要求 per-subagent 控制）。

### 4.4 对 pi 的适配判断
- pi 现有 memory_search/memory 工具面与 CC 本地机制不同但方向一致；**值得抄的是写侧纪律**（超限显式报错不静默截断、凭据拒写、symlink 逃逸拒绝）而非再增工具。CC 证明"本地记忆零专用工具 + 提示词纪律"完全可行，pi 不必为了泛化功能新造写入工具。

---

## 5. compact/summarize 与记忆的关系：**两套独立机制**

- 文档 "Instructions seem lost after /compact" 原文：
  > "**Project-root CLAUDE.md survives compaction**: after /compact, Claude re-reads it from disk and re-injects it into the session. Nested CLAUDE.md files in subdirectories and rules with paths: frontmatter load again on demand."
- auto memory 与 compact 无耦合：MEMORY.md/索引每会话开头独立加载，recall 的记忆附 age note（CHANGELOG 2.0.x 修过 "a restored memory file's age note changing between requests after a compaction or resume, which caused prompt cache misses"——说明记忆注入与 compaction 边界处理过缓存一致性）。
- 二进制中 compact 相关可见：compaction content block 类型、`/compact` typed 命令、auto-compact 设置（本机 `~/.claude/settings.json` 实测 `autoCompactEnabled: true`）。**没有 "compact 时把摘要沉淀进记忆" 的逻辑**——记忆沉淀只走 §2 的两通道 + dream。
- 会话摘要另有 `post_turn_summary` 系统 subtype（"Background post-turn summary emitted after each assistant turn"），服务于 UI/恢复，不写记忆文件。

### 对 pi 的适配判断
pi 若把「compact 时顺带沉淀记忆」当捷径可放弃——CC 明确不这么做（避免把一次性上下文污染长期记忆）。保持 pi「记忆写入 = 独立判断（模型/用户触发），与 compact 解耦」。

---

## 6. 版本演进线索（CHANGELOG + 二进制残留）

来源：`gh api repos/anthropics/claude-code/contents/CHANGELOG.md`（逐条 grep，版本号已核对）。

- **1.0.94**："/memory command now allows direct editing of all imported memory files"（早期 /memory 只是 CLAUDE.md 编辑器）
- **2.0.64**："Added support for .claude/rules/"
- **2.0.70**："**Removed # shortcut for quick memory entry** (tell Claude to edit your CLAUDE.md instead)" —— 旧版 `#` 前缀一键追加记忆的快捷键被删，官方替代 = 直接叫模型改 CLAUDE.md（任务书问的 "# 快捷键" 答案：已移除，二进制中已无对应实现）
- **2.1.59**："Claude automatically saves useful context to **auto-memory**. Manage with /memory"（auto memory GA）
- **2.1.63**："Project configs & auto memory now **shared across git worktrees** of the same repository"
- **2.1.74**：`autoMemoryDirectory` 自定义目录
- **2.1.81**：`--bare` 模式 "auto-memory fully disabled"
- **2.1.83**："MEMORY.md index now truncates at 25KB as well as 200 lines"
- **2.1.172**：team memory stores（`CLAUDE_MEMORY_STORES`）远程 recall 修复
- **2.1.186**："the agent is now **reminded to compact its MEMORY.md index** when nearing the size limit"（索引自身的"压缩提醒"机制）
- **2.1.214**：frontmatter 自动加 ISO `modified`
- **2.1.268/2.1.210**：截断警告细化 / 超限显式报错
- **2.1.273**：repo settings 选择的 memory 目录在 blockReadsOutsideWorkingDirectories 下完全不加载/不提取（安全）
- **2.1.274/2.1.287**：VSCode/终端 /memory toggle 交互完善；**2.1.285** 后台会话禁止打开 auto-memory（只能关）
- **2.1.284**：MEMORY.md 与 recalled notes 的不可见字符/伪 tag 中和（anti prompt-injection）
- 2.1.300 内残留的旧/内部机制名（二进制直读）：`tengu_memdir_disabled/loaded`（"memdir"= 旧内部名）、`tengu_team_memdir_disabled`、`pause-memory`、`org-memory-discovery`、`accountMemory`、`cc-memory`/`cc_memory`/`ccmemory`（tag 名残留：CHANGELOG 2.0.x "Fixed a stray `</ccmemory>`-style closing tag occasionally appearing in responses"）、`CLAUDE_CODE_REMOTE_MEMORY_DIR`、`CLAUDE_MEMORY_S…`（T0r: `!!process.env.CLAUDE_MEMORY_STORES?.trim()`）。dream 相关：`tengu_onyx_plover`（GrowthBook 开关）、`tengu_auto_dream_toggled`。
- 反面证据（issue 原文摘要，全部核对过 body）：
  - **#33895**（closed, area:security）"[BUG] Security violation by design - leaking project details, memory on global scale"：VS Code 场景权限/上下文跨项目泄漏，"continously write permissions and access on a global level… leaking project information between projects"。→ 全局层泄漏项目细节是真实事故类型。
  - **#95079**（open）"Auto-memory: model repeatedly writes memory files for inconclusive/low-value tasks"：无结论探索被连写两条记忆，删一条后又写"不要给无结论探索写记忆"这条记忆本身。→ 自动提取的噪音问题。
  - **#50762**（closed）"Memory-based security rules not consistently checked before sensitive operations"：记忆里的规则不保证被当约束执行。
  - **#100491**（open）：自定义 frontmatter 键被 CC 的保存流程重写丢失 → 写侧格式化会吃掉未知字段。
  - **#87027**（open）"Account-level sync for user config and auto memory"：用户在等跨项目/跨机器同步，官方尚未提供。
  - **#91188**（open）：MEMORY.md 压缩提醒阈值不可配置；**#78795**（open）：希望 topic 文件支持 rules 式 paths frontmatter 按需注入。

### 对 pi 的适配判断
- CC 的演进路径 = 「CLAUDE.md 手写（1.x）→ 加 rules/import → 加 auto memory 项目级（2.1.59）→ 加 team/org/account 云端共享层 → dream 整合」；**始终没有做项目→全局自动泛化**，且把跨层提升留给用户显式动作。pi 的泛化功能应定位为「候选生成 + 用户确认」的第四步，而非 CC 式全自动。
- 必须吸收的反面教训：噪音写入（#95079）、全局层泄漏项目细节（#33895）、frontmatter 兼容性（#100491）、"记忆规则≠被执行"（#50762）。

---

## 7. 综合判断（给主 agent 的答案）

1. **CLAUDE.md 体系**：managed/user/project/local 四层全拼接不覆盖、根→叶排序、子目录按需加载、`claudeMdExcludes` 排除（managed 豁免）、@import ≤4 跳 + 外链批准。pi 可抄排序与懒加载，不必抄 managed 层。
2. **自动记忆存在且默认开**：格式与 pi 现行完全同源（frontmatter type 四类 + MEMORY.md 索引 200 行/25KB + 一事一文件）。写入是 in-loop 提示词驱动（复用 Write 工具、两步写、索引纪律）+ 默认关闭的后台 post-turn 提取（增量游标、多级跳过条件、失败重试）。pi v2 若做自动提取，CC 的游标/跳过/互斥设计是现成蓝本；CC 2.1.284 的记忆内容消毒（不可见字符/伪 tag）是 pi 必抄的安全项。
3. **跨项目泛化：Claude Code 没有，且刻意不做自动版**——dream 只做单项目目录内整合，跨层提升（personal→team）在提示词里明文禁止自动做，全局共享靠 ~/.claude/CLAUDE.md、~/.claude/rules/、account/team/org 云端存储这些**用户显式选择**的通道。pi 的「重复记忆自动泛化成全局」是 CC 未覆盖的空白；照抄不可得，需自研，但应继承 CC 的保守立场：**泛化只产候选、用户确认后落全局**，并参考 #33895 做"全局条目不得含项目细节"的落盘检查。
4. **compact 与记忆解耦**：CLAUDE.md 在 compact 后从盘重注入；记忆沉淀不挂 compact。
5. **材料可靠性说明**：全部二进制引用来自 2.1.300 内嵌 JS 原文（非猜测）；官方文档为 code.claude.com/docs/en/memory 全文抓取（Google 搜索被 429 后降级为直接导航官方 URL，已核对页面标题 "How Claude remembers your project"）；CHANGELOG 经 GitHub API 直读。web-search 技能脚本缺失（SKILL.md 在、scripts/search.sh 不在），降级用 playwright-cli 直接访问目标页，未影响证据质量。
