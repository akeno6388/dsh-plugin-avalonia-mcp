# @kirara/dsh-plugin-avalonia-mcp

[简体中文](./README.md) | English

**Turns the "let an AI edit your Avalonia UI" dev loop from a pile of manual steps into a single installable plugin.**

## What it solves

Driving an Avalonia front end over MCP used to take four manual steps: install `cdp-cli`, add `Chrome.DevTools.Avalonia` to the app project, hand-write the `dsh-mcp-client` entry in the profile's `cordis.patch.yml`, and kill/reconnect the bridge process by hand after every app restart.

This plugin **bakes in the last two** and **turns the first two into checkable, runnable tools** (`avalonia_doctor` reports every prerequisite and prints the exact fix), while keeping itself up to date from GitHub.

> **The foundation is not ours.** The CDP server and `cdp-cli` come from [wieslawsoltes/CDP](https://github.com/wieslawsoltes/CDP) (NuGet `Chrome.DevTools.Avalonia`, dotnet tool `Chrome.DevTools.Cli`). This project contributes **orchestration, diagnostics, and distribution** only.

## Tools

| Tool | What it does | Semantics |
|---|---|---|
| `avalonia_status` | App process / CDP port / MCP bridge / whether the built exe is stale — in one look | read-only · idempotent |
| `avalonia_launch` | Start the app if it is not running, then wait for CDP | idempotent |
| `avalonia_restart` | Stop the app → start it → wait for CDP → restart the bridge (the bridge drops on every app restart; this is the standard move) | **destructive** |
| `avalonia_reconnect` | Restart only the bridge, leave the app alone | idempotent |
| `avalonia_build` | `dotnet build` (Debug includes CDP, Release does not) | idempotent · network |
| `avalonia_doctor` | Full-chain check: cdp-cli, package reference, `CdpServer.Start`, exe, port | read-only · idempotent |
| `avalonia_guide` | Selector conventions and the four known traps (CJK selectors, hidden pages, `:nth-child`, bridge drop) | read-only · idempotent |
| `avalonia_update` | Plugin self-update: `status` / `check` / `sync` / `rollback` | **destructive** · network |

The four MCP hints (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) **all default to the unsafe side** — `destructiveHint` defaults to `true`. So every tool carries a trailing `MCP hints: …` line in its `description`. Values and rationale:

<details>
<summary>Expand: full hint values for all 8 tools</summary>

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Rationale |
|---|:---:|:---:|:---:|:---:|---|
| `avalonia_status` | ✅ | — | ✅ | — | Reads process / port / exe mtimes only |
| `avalonia_launch` | — | — | ✅ | — | Returns early when already running |
| `avalonia_restart` | — | ✅ | — | — | Kills the app process; unsaved state is lost |
| `avalonia_reconnect` | — | — | ✅ | — | Only kills the stateless `cdp-cli` bridge |
| `avalonia_build` | — | — | ✅ | ✅ | Writes `bin/obj`; NuGet restore hits the network |
| `avalonia_doctor` | ✅ | — | ✅ | — | Reads project file, exe, port only |
| `avalonia_guide` | ✅ | — | ✅ | — | Returns static text |
| `avalonia_update` | — | ✅ | — | ✅ | Downloads and overwrites `lib/` from GitHub |

</details>

DSH's `defineTool` has no annotation field (extra properties are silently dropped), so the values are declared once in `TOOL_HINTS` in `lib/impl.js` and appended to each tool's `description` by a thin wrapper. The 10 `mcp__avalonia__*` MCP tools belong to the upstream `Chrome.DevTools.Cli`; their annotations are not part of this repository.

## Install

```bash
node scripts/deploy.mjs --dry-run   # see what would change
node scripts/deploy.mjs             # write + pnpm install
```

After installing you **must**:

1. Delete the earlier hand-written `mcp-avalonia-cdp` insert block from the profile's `cordis.patch.yml` (duplicate serverName conflicts);
2. Restart DSH — `dsh.profile.bundles` is only read at startup;
3. Refresh the browser — the detail-page update controls are a `dsh.client` plugin and load with the page.

## Prerequisites

- `dotnet tool install -g Chrome.DevTools.Cli` (provides `cdp-cli`)
- The app project references `Chrome.DevTools.Avalonia`, and `App.axaml.cs` calls `CdpServer.Start(9222)` in the Debug branch
- The app runs as a Debug build (Release has no CDP)

`avalonia_doctor` checks each of these and prints the exact fix.

## Self-update

On sync: resolve the latest commit that touched `lib/` (stamp-only and docs-only commits do not count as an update) → download the `codeload` tarball for that sha → unpack with the built-in ustar reader (no third-party deps) → validate the package name and payload → back up `lib/` and `locale/` → rewrite with `?v=<sha>` and re-import — **effective immediately, no DSH restart**; a failed mount falls back to the previous implementation.

- **Trigger:** this plugin's detail page in the plugin manager (badge + Check / Sync buttons + a status section, rendered by `lib/client.js`); the `avalonia_update` tool; the `/kirara-avalonia-mcp-update/state|check|sync|rollback` routes (same-origin checked); once at startup and every 6 hours afterwards (check only, no install).
- **State:** `<DSH_HOME>/kirara-plugins/@kirara-dsh-plugin-avalonia-mcp/` (`state.json`, `releases/`, `backups/`).
- **Config:** write it on the `avalonia-mcp-tools` entry in the profile's `cordis.patch.yml`; changes apply immediately (config-level HMR).

| Key | Default | Meaning |
|---|---|---|
| `updateChannel` | `main` | Branch or tag to follow |
| `updateAutoCheck` | `true` | Check at startup, then every 6 hours |
| `updateStoreRoot` | empty | Empty = `<DSH_HOME>/kirara-plugins` |
| `updateRoutePath` | `/kirara-avalonia-mcp-update` | Route prefix |

- **Known limits:** running `pnpm install` in the profile restores the package directory to the manifest version (the boot layer falls back to the bundled implementation when `release.json` no longer matches); only one sync job at a time; GitHub must be reachable.

## Development / uninstall

```bash
node scripts/stamp.mjs               # write BUNDLED_SHA before a release (--check verifies only)
node scripts/check-kernel-parity.mjs # byte-compare the update kernel with sibling repos
node scripts/deploy.mjs --disable    # remove from bundles (tools disappear after restart)
```

`lib/index.js` is the boot layer (self-update state machine, routes, `avalonia_update`); `lib/impl.js` is the implementation layer (the 7 dev-loop tools, replaced wholesale on self-update). `deploy.mjs` backs up `package.json` / `pnpm-lock.yaml` to `*.bak-<timestamp>` before each install.
