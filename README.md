# @kirara/dsh-plugin-avalonia-mcp

简体中文 | [English](./README.en.md)

**把「AI 改 Avalonia 界面」的开发循环，从一堆手工步骤变成一个装完就能用的插件。**

## 它解决什么

接 Avalonia 前端原本要手工做四件事：装 `cdp-cli`、给应用工程加 `Chrome.DevTools.Avalonia`、在 profile 的 `cordis.patch.yml` 里手写 `dsh-mcp-client` 行、应用重启后手动杀桥进程重连。

本插件**把后两件固化**下来，**把前两件做成可检查、可执行的工具**（`avalonia_doctor` 逐项体检并给出修复命令），并让插件自己跟着 GitHub 走。

> **底层不是本项目的。** CDP 服务端与 `cdp-cli` 来自 [wieslawsoltes/CDP](https://github.com/wieslawsoltes/CDP)（NuGet `Chrome.DevTools.Avalonia`、dotnet tool `Chrome.DevTools.Cli`）。本项目只做**编排、诊断、分发**。

## 工具

| 工具 | 用途 | 语义 |
|---|---|---|
| `avalonia_status` | 应用进程 / CDP 端口 / MCP 桥 / exe 是否过期，一次看全 | 只读 · 幂等 |
| `avalonia_launch` | 没跑就启动，并等 CDP 就绪 | 幂等 |
| `avalonia_restart` | 停应用 → 启动 → 等 CDP → 重启桥（应用重启后桥会掉线，这是标配动作） | **破坏性** |
| `avalonia_reconnect` | 只重启桥，不动应用 | 幂等 |
| `avalonia_build` | `dotnet build`（Debug 含 CDP，Release 不含） | 幂等 · 联网 |
| `avalonia_doctor` | 全链路体检：cdp-cli、包引用、`CdpServer.Start`、exe、端口 | 只读 · 幂等 |
| `avalonia_guide` | 选择器约定与四个已知坑（中文选择器、隐藏页面、`:nth-child`、重启掉线） | 只读 · 幂等 |
| `avalonia_update` | 插件自更新：`status` / `check` / `sync` / `rollback` | **破坏性** · 联网 |

MCP 的四个 hint（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`）**默认值全在「不安全」一侧**——破坏性默认就是 `true`。所以每个工具的 `description` 末尾都带一行 `MCP hints: …`，取值与依据：

<details>
<summary>展开：8 个工具的完整 hint 取值</summary>

| 工具 | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | 依据 |
|---|:---:|:---:|:---:|:---:|---|
| `avalonia_status` | ✅ | — | ✅ | — | 只读进程 / 端口 / exe 时间戳 |
| `avalonia_launch` | — | — | ✅ | — | 已在运行则提前返回，无额外副作用 |
| `avalonia_restart` | — | ✅ | — | — | 会 kill 应用进程，未保存状态丢失 |
| `avalonia_reconnect` | — | — | ✅ | — | 只 kill 无状态的 `cdp-cli` 桥 |
| `avalonia_build` | — | — | ✅ | ✅ | 写 `bin/obj`，NuGet restore 联网 |
| `avalonia_doctor` | ✅ | — | ✅ | — | 只读工程文件、exe、端口 |
| `avalonia_guide` | ✅ | — | ✅ | — | 返回静态文本 |
| `avalonia_update` | — | ✅ | — | ✅ | 下载并覆盖 `lib/`，需连 GitHub |

</details>

DSH 的 `defineTool` 没有注解字段（多传会被静默丢弃），因此在 `lib/impl.js` 的 `TOOL_HINTS` 里声明一次、由包装层自动追加到每个工具的 `description`。`mcp__avalonia__*` 那 10 个 MCP 工具的注解属于上游 `Chrome.DevTools.Cli`，不在本仓库。

## 安装

```bash
node scripts/deploy.mjs --dry-run   # 先看要改什么
node scripts/deploy.mjs             # 写入 + pnpm install
```

安装后**必须**：

1. 删掉 profile `cordis.patch.yml` 里早期手工加的 `mcp-avalonia-cdp` insert 块（同名 serverName 会冲突）；
2. 重启 DSH —— `dsh.profile.bundles` 只在启动时读取。

## 前置条件

- `dotnet tool install -g Chrome.DevTools.Cli`（提供 `cdp-cli`）
- 应用工程引用 `Chrome.DevTools.Avalonia`，且 `App.axaml.cs` 在 Debug 分支调用 `CdpServer.Start(9222)`
- 应用以 Debug 运行（Release 不含 CDP）

`avalonia_doctor` 会逐项检查以上内容并给出修复命令。

## 自更新

同步时：查远端 `lib/impl.js` 的最近提交 → 下 `codeload` 的 tar.gz → 内置 ustar 解包（零第三方依赖）→ 校验包名与产物 → 备份 `lib/`、`locale/` 后覆盖 → 换 `?v=<sha>` 重新 import —— **不重启 DSH 即时生效**；挂载失败自动装回旧实现。

- **触发**：`avalonia_update` 工具；`/kirara-avalonia-mcp-update/state|check|sync|rollback` 路由（同源校验）；启动后自动查一次，之后每 6 小时（只查不装）。
- **产物**：`<DSH_HOME>/kirara-plugins/@kirara-dsh-plugin-avalonia-mcp/`（`state.json`、`releases/`、`backups/`）。
- **配置**：写在 profile `cordis.patch.yml` 的 `avalonia-mcp-tools` 行，改完立刻生效（配置级 HMR）。

| 键 | 默认 | 说明 |
|---|---|---|
| `updateChannel` | `main` | 跟随哪个分支/标签 |
| `updateAutoCheck` | `true` | 启动后自动查一次，之后每 6 小时 |
| `updateStoreRoot` | 空 | 留空 = `<DSH_HOME>/kirara-plugins` |
| `updateRoutePath` | `/kirara-avalonia-mcp-update` | 路由前缀 |

- **已知边界**：profile 里跑 `pnpm install` 会把包目录还原成清单版本（引导层检测到 `release.json` 不匹配时回退随包实现）；同一时间只允许一个同步任务；需要能连上 GitHub。

## 开发 / 卸载

```bash
node scripts/stamp.mjs               # 发版前写 BUNDLED_SHA（--check 只校验）
node scripts/check-kernel-parity.mjs # 更新内核与兄弟仓库逐字节比对
node scripts/deploy.mjs --disable    # 从 bundles 移除（重启后插件工具消失）
```

`lib/index.js` 是引导层（自更新状态机、路由、`avalonia_update`），`lib/impl.js` 是实现层（7 个开发循环工具，自更新时整体替换）。`deploy.mjs` 每次安装前把 `package.json` / `pnpm-lock.yaml` 备份成 `*.bak-<时间戳>`。
