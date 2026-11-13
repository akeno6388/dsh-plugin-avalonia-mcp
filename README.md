# @kirara/dsh-plugin-avalonia-mcp

把「用 MCP 读/调 Avalonia 前端」从手工配置变成一次安装，并且**自带 GitHub 自更新**（与 `@kirara/dsh-plugin-kirara-dev` / `-theme` 同款内核）。

## 它解决什么

之前接 Avalonia 前端要手工做四件事：装 `cdp-cli`、给应用加 `Chrome.DevTools.Avalonia`、在 profile 的 `cordis.patch.yml` 里手写 `dsh-mcp-client` 行、应用重启后手动杀桥进程重连。
这个插件把后两件事固化下来，把第一、三件做成可检查、可执行的工具，并让插件自己跟着 GitHub 走。

## 组成

| 部分 | 作用 |
|---|---|
| `cordis.patch.yml` | bundle patch：insert `dsh-mcp-client`（serverName=avalonia，`cdp-cli mcp`）+ 本插件自己的行 |
| `lib/index.js` | 引导层：挂实现、跑自更新状态机、暴露路由与 `avalonia_update` |
| `lib/impl.js` | 实现层：7 个 `avalonia_*` 开发循环工具（自更新时整体替换） |
| `lib/update.js` | 自更新内核（零依赖，与另两个 kirara 插件逐字节相同） |
| `scripts/deploy.mjs` | 幂等装进 profile（依赖 + bundles + pnpm install，带备份） |
| `scripts/stamp.mjs` | 写发版印章 `BUNDLED_SHA` |
| `scripts/check-kernel-parity.mjs` | 内核漂移校验 |

## 工具

| 工具 | 用途 |
|---|---|
| `avalonia_status` | 应用进程 / CDP 端口 / MCP 桥 / exe 是否过期，一次看全 |
| `avalonia_launch` | 没跑就启动，并等 CDP 就绪 |
| `avalonia_restart` | 停应用 → 启动 → 等 CDP → 重启 MCP 桥（应用重启后桥会掉线，这是标配动作） |
| `avalonia_reconnect` | 只重启桥，不动应用 |
| `avalonia_build` | `dotnet build`（Debug 含 CDP，Release 不含） |
| `avalonia_doctor` | 全链路体检：cdp-cli、包引用、`CdpServer.Start`、exe、端口 |
| `avalonia_guide` | 选择器约定与四个已知坑（中文选择器、隐藏页面、`:nth-child`、重启掉线） |
| `avalonia_update` | 插件自更新：`status` / `check` / `sync` / `rollback` |

## 自更新

引导层把 `lib/impl.js` 挂成子 fiber；同步时依次：

1. 查远端实现层提交（`GET /repos/<repo>/commits?path=lib/impl.js`，失败退回 `info/refs`）；
2. 下 `codeload.github.com/<repo>/tar.gz/<sha>`；
3. 内置 ustar 解包（零第三方依赖，pnpm 不参与）；
4. 校验产物（包名 + 必须含 `lib/impl.js`）；
5. 备份旧的 `lib/`、`locale/` 后覆盖；
6. `dispose` 旧实现 → `import('…/impl.js?v=<sha>')` → 重新挂载 —— **不重启 DSH 即时生效**。

新实现挂载失败会自动装回旧实现。

### 触发方式

- 模型：`avalonia_update` 工具（`status` / `check` / `sync` / `rollback`）；
- 脚本：`GET /kirara-avalonia-mcp-update/state`、`POST .../check|sync|rollback`（同源校验）；
- 自动：启动后查一次（只查不装），之后每 6 小时一次。

### 配置

写在 profile 的 `cordis.patch.yml` 的 `avalonia-mcp-tools` 行（配置级 HMR，改完立刻生效）：

| 键 | 默认 | 说明 |
|---|---|---|
| `updateChannel` | `main` | 跟随哪个分支/标签 |
| `updateAutoCheck` | `true` | 启动后自动查一次，之后每 6 小时 |
| `updateStoreRoot` | 空 | 留空 = `<DSH_HOME>/kirara-plugins` |
| `updateRoutePath` | `/kirara-avalonia-mcp-update` | 路由前缀 |

### 产物位置

```
<DSH_HOME>/kirara-plugins/@kirara-dsh-plugin-avalonia-mcp/
├── state.json                 当前/上一个提交、远端检查结果、历史
├── releases/<sha>/            解开并校验过的产物
└── backups/<sha>-<时间戳>/     被覆盖前的 lib/ 与 locale/
```

包目录里的 `release.json` 记录「现在这份是哪个提交同步来的」。

### 已知边界

- **pnpm 会还原**：在 profile 里跑 `pnpm install` 会把包目录恢复成清单里的版本；引导层发现 `release.json` 与实现不匹配时会回到随包实现。
- **一次只允许一个同步任务**，重复触发得到「已有任务进行中」。
- 需要能连上 GitHub（走 DSH 的统一代理策略，普通 `fetch`）。

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

## 开发

```bash
node scripts/stamp.mjs               # 发版前写 BUNDLED_SHA（--check 只校验）
node scripts/check-kernel-parity.mjs # 内核与兄弟仓库逐字节比对
```

## 卸载 / 回滚

```bash
node scripts/deploy.mjs --disable   # 从 bundles 移除（重启后插件工具消失）
```

`deploy.mjs` 每次安装前把 `package.json` / `pnpm-lock.yaml` 备份成 `*.bak-<时间戳>`。
