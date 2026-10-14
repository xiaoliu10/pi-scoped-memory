# @wengine-ai/pi-scoped-memory

pi coding agent 的双层持久记忆插件（全局 + 项目级，ZCode 形态）。

## 硬性约定

- 零运行时依赖（peerDeps 只声明 host：@earendil-works/pi-coding-agent + typebox）。
- 存储全部是纯 Markdown；写入只落两类路径：全局层 `~/.pi/agent/memory/`、项目层 `~/.pi/agent/memory-projects/<slug>-<hash16>/`。
- 注入是「读一次 + 冻结快照」（session 初始化边界），绝不在 turn 间重复读盘破坏 KV cache。
- 失败降级：读不到/解析失败 → 静默跳过该层，绝不抛错阻断会话。
- 安全：路径写死在两层 root 内（containment 校验），拒绝 traversal；frontmatter 注入面做 invisible/bidi 字符清理。
- 中文注释；测试与源码同名的 .test.ts。
