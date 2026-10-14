# pi-scoped-memory

pi coding agent 的**双层持久记忆**扩展：全局层（跨项目偏好/协作方式）+ 项目层（本仓库约束/决策，ZCode 式哈希键隔离）。零运行时依赖，默认**不需要配置模型**。

灵感与设计参照 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 memory 设计（`docs/design/v2/memory/README.md`）与 [pi-memory](https://github.com/jayzeng/pi-memory)。

## 安装

```bash
# 与 pi-memory 是替代关系（工具同名冲突），先移除旧插件
pi remove npm:pi-memory
pi install npm:pi-scoped-memory
```

## 存储布局

```
~/.pi/agent/
├── memory/                          ← 全局层（兼容 pi-memory 既有数据）
│   ├── MEMORY.md                    ← 索引（- [name](name.md) — hook，一行一条）
│   └── <fact>.md                    ← 一事一文件 + frontmatter
└── memory-projects/
   └── <slug>-<sha256[:16]>/         ← 项目层（workspacePath 哈希键，Bash cd 不换 root）
       ├── MEMORY.md
       └── <fact>.md
```

记忆不进项目目录（无误提交 git 的隐私问题）；哈希键让同一路径永远命中同一 root。

## 注入

会话初始化读一次两层索引（各 ≤200 行 / 25K 字符，超限截断），以固定分段拼进系统提示（全局在前、项目在后，各自标注来源）。快照在会话内字节稳定——不破坏 KV cache。两层都空则不注入。

## 工具

| 工具 | 说明 |
|---|---|
| `memory_write` | 写一条事实（name/description/type/body，可选 target）。**默认路由**：`user`/`feedback` → 全局层；`project`/`reference` → 项目层；`target` 显式指定时覆盖。索引 pointer 自动 upsert（同名原位替换）。已有 originSessionId 的文件原样保留，不覆盖 |
| `memory_read` | 读某层的事实文件或 MEMORY.md |
| `memory_search` | 关键词检索（默认跨两层，大小写不敏感子串） |
| `memory_status` | 两层 root 与事实计数 |

frontmatter：`name` / `description` / `metadata.type: user|feedback|project|reference` / `metadata.originSessionId`（首次写入自动补，之后保留原值）。

## 需要共享的记忆放哪？

- **跨项目复用的用户偏好/协作方式** → 全局层（`type=user`/`feedback`，默认路由自动进）。
- **必须"指令级"长期生效的约定** → 沉淀进 `~/.pi/agent/AGENTS.md`（pi 原生指令层，优先级高于记忆）。
- **本项目的约束/决策** → 项目层（`type=project`，默认路由自动进）。

## 与 Desktop（PI Desktop）的关系

PI Desktop 检测到本插件后自动让位：不再用 env 把记忆根强指到项目目录，插件的全局+项目双层在 Desktop 会话与 CLI 裸跑时行为一致。Desktop 的自动摘要链（写 daily）不受影响。

## 路线

- v1（当前）：双层注入 + 写入路由 + 关键词检索。零模型依赖。
- v2：`agent_settled` 后台提取（ZCode 双槽 + cursor 语义）、qmd 语义检索（每项目独立集合）、`/memory` 命令与只读 viewer。

## 开发

```bash
npm install
npm test        # vitest，19 tests
npm run typecheck
```

真机冒烟：

```bash
T=$(mktemp -d); mkdir -p $T/memory
printf -- '- [smoke-fact](smoke-fact.md) — SMOKE_MARKER\n' > $T/memory/MEMORY.md
PI_SCOPED_MEMORY_HOME=$T pi -ne -e $PWD -p "逐字重复你系统提示中 Scoped Memory 段的内容"
```

## License

MIT
