/**
 * @kirara/dsh-plugin-avalonia-mcp —— 宿主半边【引导层】
 * ============================================================================
 *
 * 与 @kirara/dsh-plugin-kirara-dev / -theme 同款结构，刻意保持很薄：
 *
 *   1. 把真正的实现（lib/impl.js）挂成自己的子 fiber —— 自更新同步后整体换掉，
 *      引导层不动，所以「换实现」不需要重启 DSH；
 *   2. 跑自更新状态机（查 GitHub → 下 tar.gz → 解包 → 覆盖包目录 → 备份 → 回滚）；
 *   3. 暴露同源 HTTP 路由（状态 / 检查 / 同步 / 回滚），给脚本或未来的详情页用；
 *   4. 注册 avalonia_update 工具，让模型自己也能查/同步/回滚；
 *   5. 同步成功后：dispose 旧实现 → import('…/impl.js?v=<sha>') → 重新挂载。
 *
 * 为什么更新内核是 lib/update.js 而不是 pnpm：替换已安装包的版本属于启动期操作，
 * 而这里要的是运行期热切换；产物直接落到插件包目录，pnpm 完全不参与。
 *
 * ⚠️ lib/update.js 在三个 kirara 插件仓库里是**逐字节相同的副本**，
 *    改动必须同步（各仓库的 scripts/check-kernel-parity.mjs 会挡住漂移）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BUNDLED_SHA } from './build-info.js';
import { DEFAULT_CHECK_INTERVAL_MS, createLogBuffer, createUpdater } from './update.js';

export const name = 'avalonia-mcp';

/**
 * DSH 服务依赖：工具注册表。
 * 引导层也要注册 avalonia_update，同样必须显式声明 inject，否则被 Cordis 守卫拦下。
 */
export const inject = ['tools'];

/** 包名与仓库：自更新的身份标识（必须与 package.json / GitHub 仓库一致）。 */
const PKG_NAME = '@kirara/dsh-plugin-avalonia-mcp';
const REPO = 'akeno6388/dsh-plugin-avalonia-mcp';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const IMPL_FILE = join(PACKAGE_DIR, 'lib', 'impl.js');
const RELEASE_FILE = join(PACKAGE_DIR, 'release.json');
const DEFAULT_ROUTE_PATH = '/kirara-avalonia-mcp-update';

/**
 * 引导层配置：只声明自更新字段。
 * ⚠️ 实现层的字段（appProjectDir / exeRelativePath / …）不在这里重复声明，
 *    它们靠 schemastery 的未知键透传原样到达实现层。
 */
export const Config = z.object({
  /** 跟随哪个分支/标签（默认 main）。 */
  updateChannel: z.string().default('main'),
  /** 启动后是否自动检查一次更新（默认 true；只查不装）。 */
  updateAutoCheck: z.boolean().default(true),
  /** 更新产物与备份的根目录（默认 <DSH_HOME>/kirara-plugins/<包名>）。 */
  updateStoreRoot: z.string().default(''),
  /** 状态/同步路由前缀。 */
  updateRoutePath: z.string().default(DEFAULT_ROUTE_PATH),
});

function normalizeRoutePath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return DEFAULT_ROUTE_PATH;
  return ('/' + raw.replace(/^\/+|\/+$/g, '')).replace(/\/{2,}/g, '/') || DEFAULT_ROUTE_PATH;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 已落地的实现对应哪个提交：包目录里 release.json 说了算，否则就是随包那一份。 */
function resolveAppliedSha() {
  if (!existsSync(RELEASE_FILE)) return BUNDLED_SHA;
  try {
    const release = JSON.parse(readFileSync(RELEASE_FILE, 'utf8'));
    return typeof release.sha === 'string' && release.sha ? release.sha : BUNDLED_SHA;
  } catch {
    return BUNDLED_SHA;
  }
}

function shortSha(sha) {
  return typeof sha === 'string' && sha ? sha.slice(0, 8) : '(未知)';
}

/** 把 updater.status() 压成模型可读的几行。 */
function formatStatus(state) {
  const lines = [];
  lines.push(`仓库: ${state.repo}@${state.channel}`);
  lines.push(`当前: ${shortSha(state.current?.sha)}（${state.current?.source ?? 'bundled'}）`);
  if (state.remote?.sha) {
    lines.push(`远端: ${shortSha(state.remote.sha)}（检查于 ${state.remote.checkedAt ?? '未知'}）`);
  } else {
    lines.push('远端: 尚未检查');
  }
  lines.push(`可更新: ${state.updateAvailable ? '是' : '否'}`);
  if (state.busy && state.busy !== 'idle') lines.push(`进行中: ${state.busy}`);
  if (state.lastError) lines.push(`上次错误: ${state.lastError}`);
  if (state.previous?.sha) lines.push(`上一版本: ${shortSha(state.previous.sha)}`);
  if (Array.isArray(state.log) && state.log.length) {
    lines.push('最近日志:');
    for (const item of state.log.slice(0, 5)) lines.push(`  - [${item.level}] ${item.text}`);
  }
  return lines.join('\n');
}

export async function apply(ctx, config) {
  const routePath = normalizeRoutePath(config.updateRoutePath);
  const log = createLogBuffer();
  const updater = createUpdater({
    pkgName: PKG_NAME,
    repo: REPO,
    packageDir: PACKAGE_DIR,
    bundledSha: BUNDLED_SHA,
    config,
    log,
  });

  let mountedSha = resolveAppliedSha();
  let scope = null;

  const importImpl = (sha) => import(pathToFileURL(IMPL_FILE).href + '?v=' + encodeURIComponent(sha || 'bundled'));

  /** 挂载一份实现，并把它记成当前实现。 */
  const mount = async (sha) => {
    const mod = await importImpl(sha);
    const mounted = ctx.plugin(mod, config);
    await mounted;
    scope = mounted;
    mountedSha = sha;
    return mounted;
  };

  /**
   * 热重载：先 import 新版（失败就不动现场）→ dispose 旧实现 → 挂载新实现。
   * 新实现挂载失败时自动把旧实现装回去，并把错误抛给调用方。
   */
  const reload = async (sha) => {
    const nextMod = await importImpl(sha);
    const previousSha = mountedSha;
    const previousScope = scope;
    scope = null;
    if (previousScope) {
      try {
        previousScope.dispose();
      } catch (error) {
        log.push('warn', '旧实现卸载时报错：' + String((error && error.message) || error));
      }
    }
    try {
      const mounted = ctx.plugin(nextMod, config);
      await mounted;
      scope = mounted;
      mountedSha = sha;
      log.push('info', '已热重载到 ' + String(sha || 'bundled').slice(0, 8));
    } catch (error) {
      log.push('error', '新版本挂载失败，回滚到 ' + String(previousSha || 'bundled').slice(0, 8) + '：' + String((error && error.message) || error));
      const fallback = await importImpl(previousSha);
      const mounted = ctx.plugin(fallback, config);
      await mounted;
      scope = mounted;
      mountedSha = previousSha;
      throw error;
    }
  };

  // 1) 先把实现挂上：此时工具全部就位。
  await mount(mountedSha);

  // 2) 自更新路由（挂在引导层上，所以换实现不会把更新入口弄丢）。
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const isSameOrigin = (req) => {
        const origin = req.headers && req.headers.origin;
        const host = req.headers && req.headers.host;
        if (!origin || !host) return true;
        try {
          return new URL(origin).host === host;
        } catch {
          return false;
        }
      };

      const runSync = async (sha) => {
        try {
          const result = await updater.sync(sha ? { sha } : {});
          if (result.changed) await reload(result.sha);
          return result;
        } catch (error) {
          log.push('error', '同步流程失败：' + String((error && error.message) || error));
          return { changed: false, error: String((error && error.message) || error) };
        }
      };

      const runRollback = async () => {
        try {
          const result = await updater.rollback();
          await reload(result.sha);
          return result;
        } catch (error) {
          log.push('error', '回滚流程失败：' + String((error && error.message) || error));
          return { changed: false, error: String((error && error.message) || error) };
        }
      };

      const disposeRoute = child.webServer.register({
        kind: 'prefix',
        path: routePath,
        handler: async (req, res) => {
          try {
            const raw = req.url || routePath;
            const queryIndex = raw.indexOf('?');
            const pathname = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
            const suffix = pathname.slice(routePath.length).replace(/^\/+/, '');
            const method = (req.method || 'GET').toUpperCase();

            if (method === 'GET' || method === 'HEAD') {
              if (suffix === '' || suffix === 'state' || suffix === 'state.json') {
                sendJson(res, 200, updater.status());
                return;
              }
              sendJson(res, 404, { error: 'unknown path: ' + suffix });
              return;
            }

            if (method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            if (!isSameOrigin(req)) {
              sendJson(res, 403, { error: 'cross-origin request rejected' });
              return;
            }

            if (suffix === 'check' || suffix === 'check.json') {
              try {
                await updater.check();
              } catch (error) {
                log.push('warn', '检查更新失败：' + String((error && error.message) || error));
              }
              sendJson(res, 200, updater.status());
              return;
            }
            if (suffix === 'sync') {
              // 下载可能几十秒：立刻回 202，让调用方轮询 /state 看进度。
              void runSync();
              sendJson(res, 202, updater.status());
              return;
            }
            if (suffix === 'rollback') {
              void runRollback();
              sendJson(res, 202, updater.status());
              return;
            }
            sendJson(res, 404, { error: 'unknown action: ' + suffix });
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) });
          }
        },
      });

      // 3) 自动检查：启动后一次（不装），之后每 6 小时一次。
      const autoCheck = config.updateAutoCheck !== false;
      const timer = autoCheck
        ? setInterval(() => {
            void updater.check({ silent: true }).catch(() => {});
          }, DEFAULT_CHECK_INTERVAL_MS)
        : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      if (autoCheck) void updater.check({ silent: true }).catch(() => {});

      return () => {
        if (timer) clearInterval(timer);
        disposeRoute();
      };
    }, 'avalonia-mcp:update-route');
  });

  // 4) 让模型自己也能查/同步/回滚（没有详情页 UI，这条工具就是操作入口）。
  try {
    ctx.tools.register(
      defineTool({
        name: 'avalonia_update',
        description:
          'Self-update for the avalonia-mcp plugin itself: status / check / sync / rollback against GitHub ' +
          '(akeno6388/dsh-plugin-avalonia-mcp). sync applies the latest implementation and hot-reloads it without restarting DSH. ' +
          'Use after changing the plugin, or when a tool behaves like an older version.',
        parameters: {
          action: {
            type: 'string',
            enum: ['status', 'check', 'sync', 'rollback'],
            required: true,
            description: 'status = local view; check = ask GitHub; sync = download + apply + hot reload; rollback = restore previous.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const action = String(args.action || 'status');
          if (action === 'check') {
            await updater.check();
            return formatStatus(updater.status());
          }
          if (action === 'sync') {
            const result = await updater.sync({});
            if (result.changed) {
              await reload(result.sha);
              return `已同步并热重载到 ${shortSha(result.sha)}。\n` + formatStatus(updater.status());
            }
            return '已是最新，无需同步。\n' + formatStatus(updater.status());
          }
          if (action === 'rollback') {
            const result = await updater.rollback();
            await reload(result.sha);
            return `已回滚到 ${shortSha(result.sha)}。\n` + formatStatus(updater.status());
          }
          return formatStatus(updater.status());
        },
      }),
    );
  } catch (error) {
    console.error('[avalonia-mcp] 注册 avalonia_update 失败：', error);
  }

  // 5) 插件卸载时把实现一并卸掉。
  ctx.effect(() => () => {
    if (scope) {
      try {
        scope.dispose();
      } catch {
        /* 卸载期的异常不再向上抛 */
      }
      scope = null;
    }
  }, 'avalonia-mcp:impl');
}
