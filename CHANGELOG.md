# Changelog

## 0.1.1 — 2026-10-15

### Added

- **`memory_consolidate` 工具**：跨项目记忆泛化的显式触发流程（propose → apply 两阶段），零模型依赖。
  - `action: propose`（无参）：扫描全部项目层 + 全局层，按 name 归一化（去日期/hash 后缀）粗筛候选簇，跨 ≥2 来源成簇，全局既有等价条目纳入供 merge 判定，`legacy-` 前缀归档排除
  - `action: propose`（带 proposals）：落提案文件 `.consolidation/proposals/<ts>.{json,md}`（md 供 review gate 展示），不写任何记忆层
  - `action: apply`（带 proposalId）：6 步护栏确定性执行——类型门 → 敏感扫描 → CAS 校验 → 写全局（force 覆盖 + provenance）→ 源条目 `promotedTo` 标注（不删）→ 完成验证 + journal
  - 语义判定（promote/merge/noop/conflict）由会话 agent 完成，工具绝不自动写全局层
  - 设计依据 Claude Code 逆向（刻意不自动泛化）+ mem0/Letta/Graphiti/LangMem 调研，详见 `docs/design/memory-consolidation.md`

### Changed

- `paths.ts`: 新增 `enumerateProjectRoots()`、`consolidationDir()`、`clearProjectRootCache()`
- `facts.ts`: `renderFact` 加 `force` 选项（apply 覆盖已有 origin，默认 false 不破坏 writeFact 语义）；新增 `appendPromotedToAnnotation`
- README: 工具表加 `memory_consolidate`；新增「跨项目记忆泛化」章节

### Fixed

- 类型门只挡 `promote`（新建全局上浮），放行 `merge`（标注项目层既有，非上浮）——litellm 09-25 迁移遗留的 `project` 类型双层重复可正确处置
- `sha256File` 原用 `require('node:crypto')` 在 ESM 环境静默返回 null（所有 CAS 校验误判 TOCTOU），改用顶部 `import { createHash }`

## 0.1.0 — 2026-10-14

- 初始版本：双层注入（全局 + 项目哈希键）、`memory_write` type 路由、frontmatter 补齐、关键词检索
