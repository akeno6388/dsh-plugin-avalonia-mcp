/**
 * @kirara/dsh-plugin-avalonia-mcp —— 宿主半边【实现层】
 * ============================================================================
 *
 * 由 lib/index.js（引导层）挂成子 fiber：自更新同步后会被整体换掉，
 * 所以这里只放「工具」本身，不放更新状态机、不放路由。
 *
 * 目标：把「用 MCP 读/调 Avalonia 前端」这件事从手工配置变成一条命令。
 *
 * 组成：
 *   - cordis.patch.yml 里挂 dsh-mcp-client（cdp-cli mcp）→ 模型拿到 mcp__avalonia__* 10 个工具；
 *   - 本文件注册 avalonia_* 宿主工具，补齐 MCP 管不到的「周边设施」：
 *       构建、启动、重启、重连、体检、选择器指南。
 *
 * 为什么这些必须放在插件里而不是 MCP 里：
 *   cdp-cli 只在启动时连一次 CDP；应用一重启它就成僵尸（ws is null），
 *   而它自己不会重连。DSH 的 MCP 客户端会在进程退出后重新 spawn，
 *   所以「杀掉 cdp-cli」就是重连开关 —— 这段知识属于 DSH 侧，不属于 MCP。
 *
 * 全部工具 Windows 专用（项目本身是 WinUI/Avalonia Windows 桌面端）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'avalonia-mcp-tools';

/**
 * DSH 服务依赖：工具注册表。
 * 缺这一行时 Cordis 的反射守卫会拒绝 `ctx.tools`（"cannot get property tools
 * without inject"），7 个工具会逐个注册失败、插件看起来「装好了但没有工具」。
 */
export const inject = ['tools'];

const IS_WINDOWS = process.platform === 'win32';

export const Config = z.object({
  /** Avalonia 应用工程目录；留空则用 <workspace>/kirara_server_app。 */
  appProjectDir: z.string().default(''),
  /** 相对工程目录的 exe 路径（Debug 输出）。 */
  exeRelativePath: z.string().default('bin/Debug/net10.0/Kirara_Server_APP.exe'),
  /** 应用进程名（不带 .exe）。 */
  processName: z.string().default('Kirara_Server_APP'),
  /** MCP 桥进程名（不带 .exe）。 */
  bridgeProcessName: z.string().default('cdp-cli'),
  /** CDP 端口。 */
  cdpPort: z.number().default(9222),
  /** 启动后等待 CDP 就绪的上限。 */
  launchTimeoutMs: z.number().default(60000),
});

// ── 基础设施 ────────────────────────────────────────────────────────────────

/** 工程目录：配置 > DSH_WORKSPACE > cwd，再拼 kirara_server_app。 */
function appDirOf(config) {
  if (config.appProjectDir && config.appProjectDir.trim()) return resolve(config.appProjectDir.trim());
  const workspace = (process.env.DSH_WORKSPACE || process.env.DSH_WORKING_DIRECTORY || process.cwd() || '').trim();
  return join(workspace || process.cwd(), 'kirara_server_app');
}

function exePathOf(config) {
  return join(appDirOf(config), config.exeRelativePath);
}

function csprojOf(config) {
  const dir = appDirOf(config);
  const candidates = ['Kirara_Server_APP.csproj'];
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  return join(dir, 'Kirara_Server_APP.csproj');
}

/** 同步执行并收集输出（不抛异常，把退出码交回调用方）。 */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 120000,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: typeof result.status === 'number' ? result.status : -1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

/** tasklist 查进程：返回 PID 数组。 */
function pidsOf(imageName) {
  if (!IS_WINDOWS) return [];
  const out = run('tasklist', ['/FI', `IMAGENAME eq ${imageName}.exe`, '/FO', 'CSV', '/NH'], { timeoutMs: 15000 });
  if (out.code !== 0) return [];
  const pids = [];
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) pids.push(Number(m[2]));
  }
  return pids;
}

function killByImage(imageName) {
  if (!IS_WINDOWS) return { code: 0, stdout: '', stderr: '' };
  return run('taskkill', ['/IM', `${imageName}.exe`, '/F'], { timeoutMs: 15000 });
}

/** GET 一个 JSON 端点；失败返回 null。 */
function httpJson(port, pathname, timeoutMs = 3000) {
  return new Promise((resolvePromise) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(body));
        } catch {
          resolvePromise(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolvePromise(null); });
    req.on('error', () => resolvePromise(null));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值或超时；返回最后一次的值。 */
async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

/** 最近一次源码改动时间（.cs/.axaml），用于判断 exe 是否过期。 */
function newestSourceMtime(appDir) {
  let newest = 0;
  const stack = [appDir];
  const skip = new Set(['obj', 'bin', '.git', 'node_modules']);
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(cs|axaml|xaml)$/i.test(entry.name)) {
        try {
          const m = statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* 忽略单个文件 */
        }
      }
    }
  }
  return newest;
}

function formatTime(ms) {
  if (!ms) return '（未知）';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 当前 CDP 状态：端口是否在听、有几个目标。 */
async function cdpState(port) {
  const version = await httpJson(port, '/json/version', 2000);
  if (!version) return { up: false, targets: [] };
  const list = await httpJson(port, '/json/list', 2000);
  const targets = Array.isArray(list) ? list.map((t) => ({ title: t.title, id: t.id })) : [];
  return { up: true, version, targets };
}

/** 一次性采集全部状态，多个工具复用。 */
async function snapshot(config) {
  const appPids = pidsOf(config.processName);
  const bridgePids = pidsOf(config.bridgeProcessName);
  const cdp = await cdpState(config.cdpPort);
  const exe = exePathOf(config);
  const exeExists = existsSync(exe);
  const exeMtime = exeExists ? statSync(exe).mtimeMs : 0;
  let sourceMtime = 0;
  try {
    sourceMtime = newestSourceMtime(appDirOf(config));
  } catch {
    sourceMtime = 0;
  }
  return { appPids, bridgePids, cdp, exe, exeExists, exeMtime, sourceMtime, appDir: appDirOf(config) };
}

function statusText(s, config) {
  const lines = [];
  lines.push(`工程目录: ${s.appDir}`);
  lines.push(`应用进程: ${s.appPids.length ? `运行中 (pid ${s.appPids.join(', ')})` : '未运行'}`);
  lines.push(`CDP ${config.cdpPort}: ${s.cdp.up ? `在听（${s.cdp.targets.map((t) => t.title).join(' / ') || '无目标'}）` : '不可达'}`);
  lines.push(`MCP 桥(${config.bridgeProcessName}): ${s.bridgePids.length ? `运行中 (pid ${s.bridgePids.join(', ')})` : '未运行（DSH 会在需要时重新拉起）'}`);
  if (!s.exeExists) {
    lines.push(`exe: 不存在 —— 先跑 avalonia_build（${s.exe}）`);
  } else {
    const stale = s.sourceMtime > s.exeMtime + 1000;
    lines.push(`exe: ${formatTime(s.exeMtime)}${stale ? `  ⚠️ 源码更新于 ${formatTime(s.sourceMtime)}，需要重新构建` : '  （已是最新）'}`);
  }
  if (s.appPids.length && !s.cdp.up) {
    lines.push('⚠️ 应用在跑但 CDP 不可达：多半是 Release 构建，或 CdpServer.Start(9222) 没进 Debug 分支。');
  }
  if (s.cdp.up && !s.appPids.length) {
    lines.push('⚠️ CDP 在听但没找到应用进程：可能是别的程序占用了端口。');
  }
  return lines.join('\n');
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const settings = {
    appProjectDir: config.appProjectDir ?? '',
    exeRelativePath: config.exeRelativePath ?? 'bin/Debug/net10.0/Kirara_Server_APP.exe',
    processName: config.processName ?? 'Kirara_Server_APP',
    bridgeProcessName: config.bridgeProcessName ?? 'cdp-cli',
    cdpPort: Number(config.cdpPort ?? 9222),
    launchTimeoutMs: Number(config.launchTimeoutMs ?? 60000),
  };

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  };

  const guard = (toolName, factory) => {
    try {
      ctx.tools.register(factory());
    } catch (error) {
      console.error(`[avalonia-mcp] 注册 ${toolName} 失败，其余工具继续注册：`, error);
    }
  };

  // ── 1. avalonia_status ────────────────────────────────────────────────────
  guard('avalonia_status', () =>
    defineTool({
      name: 'avalonia_status',
      description:
        'Report the Avalonia dev-loop state: app process, CDP port 9222, MCP bridge process, and whether the built exe is older than the newest .cs/.axaml. ' +
        'Call this first when MCP tools report "Not connected to a target".',
      parameters: {},
      output: textOutput,
      async execute() {
        const s = await snapshot(settings);
        return statusText(s, settings);
      },
    }),
  );

  // ── 2. avalonia_launch ────────────────────────────────────────────────────
  guard('avalonia_launch', () =>
    defineTool({
      name: 'avalonia_launch',
      description:
        'Start the Avalonia app (Debug exe) if it is not running, then wait until the CDP endpoint answers. ' +
        'Returns the pid and CDP targets. Does not rebuild — use avalonia_build first if sources changed.',
      parameters: {
        waitSeconds: {
          type: 'number',
          description: 'How long to wait for CDP to come up (default 60).',
        },
      },
      output: textOutput,
      async execute(args) {
        const timeoutMs = Math.max(5, Number(args.waitSeconds ?? 60)) * 1000;
        const existing = pidsOf(settings.processName);
        if (existing.length) {
          const cdp = await cdpState(settings.cdpPort);
          return `应用已在运行（pid ${existing.join(', ')}）。CDP ${settings.cdpPort}: ${cdp.up ? '在听' : '不可达（可能不是 Debug 构建）'}`;
        }
        const exe = exePathOf(settings);
        if (!existsSync(exe)) {
          return `找不到 exe：${exe}\n先执行 avalonia_build（Debug）。`;
        }
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        const cdp = await waitFor(async () => {
          const state = await cdpState(settings.cdpPort);
          return state.up ? state : null;
        }, timeoutMs, 700);
        const pids = pidsOf(settings.processName);
        if (!cdp) {
          return `已启动 ${exe}（pid ${pids.join(', ') || '未知'}），但 ${Math.round(timeoutMs / 1000)}s 内 CDP ${settings.cdpPort} 未就绪。\n排查：avalonia_status / 应用日志 data/logs。`;
        }
        return `已启动并连上 CDP。\npid: ${pids.join(', ') || '未知'}\n目标: ${cdp.targets.map((t) => t.title).join(' / ') || '（无）'}`;
      },
    }),
  );

  // ── 3. avalonia_restart ───────────────────────────────────────────────────
  guard('avalonia_restart', () =>
    defineTool({
      name: 'avalonia_restart',
      description:
        'Stop and restart the Avalonia app, wait for CDP, then restart the MCP bridge so mcp__avalonia__* tools reconnect. ' +
        'Use after rebuilding, since a running app locks the exe and a dead bridge keeps reporting "ws is null".',
      parameters: {
        waitSeconds: { type: 'number', description: 'CDP wait budget in seconds (default 60).' },
        restartBridge: {
          type: 'boolean',
          description: 'Restart cdp-cli after the app is back (default true).',
        },
      },
      output: textOutput,
      async execute(args) {
        const timeoutMs = Math.max(5, Number(args.waitSeconds ?? 60)) * 1000;
        const timeline = [];

        const running = pidsOf(settings.processName);
        if (running.length) {
          killByImage(settings.processName);
          const gone = await waitFor(async () => (pidsOf(settings.processName).length ? null : true), 15000, 400);
          timeline.push(`停止应用: ${gone ? `已退出（原 pid ${running.join(', ')}）` : '15s 内未退出'}`);
        } else {
          timeline.push('停止应用: 本来就没在跑');
        }

        const exe = exePathOf(settings);
        if (!existsSync(exe)) {
          return timeline.join('\n') + `\n找不到 exe：${exe}\n先执行 avalonia_build。`;
        }
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        const cdp = await waitFor(async () => {
          const state = await cdpState(settings.cdpPort);
          return state.up ? state : null;
        }, timeoutMs, 700);
        const pids = pidsOf(settings.processName);
        timeline.push(`启动应用: pid ${pids.join(', ') || '未知'}`);
        timeline.push(cdp ? `CDP: 就绪（${cdp.targets.map((t) => t.title).join(' / ') || '无目标'}）` : `CDP: ${Math.round(timeoutMs / 1000)}s 内未就绪`);

        if (args.restartBridge !== false) {
          const bridge = pidsOf(settings.bridgeProcessName);
          if (bridge.length) {
            killByImage(settings.bridgeProcessName);
            timeline.push(`重启 MCP 桥: 已结束旧进程 ${bridge.join(', ')}`);
          }
          const back = await waitFor(async () => {
            const now = pidsOf(settings.bridgeProcessName);
            return now.length ? now : null;
          }, 30000, 500);
          timeline.push(back ? `重启 MCP 桥: DSH 已重新拉起（pid ${back.join(', ')}）` : '重启 MCP 桥: 30s 内未重新拉起 —— 到 DSH 设置里重载一次 MCP，或重启 DSH');
        }

        return timeline.join('\n');
      },
    }),
  );

  // ── 4. avalonia_reconnect ─────────────────────────────────────────────────
  guard('avalonia_reconnect', () =>
    defineTool({
      name: 'avalonia_reconnect',
      description:
        'Restart only the MCP bridge (cdp-cli) without touching the app. ' +
        'Use when mcp__avalonia__* says "Not connected to a target (ws is null)" after the app was restarted.',
      parameters: {},
      output: textOutput,
      async execute() {
        const before = pidsOf(settings.bridgeProcessName);
        if (before.length) killByImage(settings.bridgeProcessName);
        const back = await waitFor(async () => {
          const now = pidsOf(settings.bridgeProcessName);
          return now.length ? now : null;
        }, 30000, 500);
        const cdp = await cdpState(settings.cdpPort);
        const lines = [
          before.length ? `已结束旧桥进程 ${before.join(', ')}` : '没有旧桥进程（可能已被 DSH 回收）',
          back ? `DSH 已重新拉起（pid ${back.join(', ')}）` : '30s 内未重新拉起',
          `CDP ${settings.cdpPort}: ${cdp.up ? '在听' : '不可达'}`,
        ];
        if (!cdp.up) lines.push('注意：应用不在 Debug 运行状态时，新桥也连不上。');
        return lines.join('\n');
      },
    }),
  );

  // ── 5. avalonia_build ─────────────────────────────────────────────────────
  guard('avalonia_build', () =>
    defineTool({
      name: 'avalonia_build',
      description:
        'Build the Avalonia app project (dotnet build). Debug builds include the CDP server; Release builds exclude it. ' +
        'A running app locks the exe, so stop it first (avalonia_restart does this automatically).',
      parameters: {
        configuration: {
          type: 'string',
          enum: ['Debug', 'Release'],
          description: 'Build configuration (default Debug).',
        },
        timeoutSeconds: { type: 'number', description: 'Build timeout (default 300).' },
      },
      output: textOutput,
      async execute(args) {
        const configuration = args.configuration === 'Release' ? 'Release' : 'Debug';
        const project = csprojOf(settings);
        if (!existsSync(project)) return `找不到工程文件：${project}`;
        const timeoutMs = Math.max(30, Number(args.timeoutSeconds ?? 300)) * 1000;
        const started = Date.now();
        const out = run('dotnet', ['build', project, '-c', configuration, '--nologo', '-v', 'q'], {
          cwd: appDirOf(settings),
          timeoutMs,
        });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const tail = [out.stdout, out.stderr].filter(Boolean).join('\n').split(/\r?\n/).slice(-12).join('\n');
        const head = out.code === 0 ? `构建成功（${configuration}，${seconds}s）` : `构建失败（exit ${out.code}，${seconds}s）`;
        return `${head}\n${tail}`;
      },
    }),
  );

  // ── 6. avalonia_doctor ────────────────────────────────────────────────────
  guard('avalonia_doctor', () =>
    defineTool({
      name: 'avalonia_doctor',
      description:
        'Check the whole MCP-for-Avalonia setup: cdp-cli installed, project references Chrome.DevTools.Avalonia, App.axaml.cs calls CdpServer.Start, exe present, port state. ' +
        'Returns findings with exact fixes.',
      parameters: {},
      output: textOutput,
      async execute() {
        const findings = [];
        const push = (ok, text, fix) => findings.push({ ok, text, fix });

        const where = run('where', ['cdp-cli'], { timeoutMs: 10000 });
        push(where.code === 0, `cdp-cli: ${where.code === 0 ? where.stdout.split(/\r?\n/)[0] : '未安装'}`, 'dotnet tool install -g Chrome.DevTools.Cli');

        const project = csprojOf(settings);
        const projectExists = existsSync(project);
        push(projectExists, `工程文件: ${projectExists ? project : `缺失（${project}）`}`, '检查 appProjectDir 配置');
        if (projectExists) {
          const text = readFileSync(project, 'utf8');
          const hasPkg = /Chrome\.DevTools\.Avalonia/i.test(text);
          push(hasPkg, `工程引用 Chrome.DevTools.Avalonia: ${hasPkg ? '是' : '否'}`, 'dotnet add package Chrome.DevTools.Avalonia --version 0.1.0（并锁 Debug）');
        }

        const appCs = join(appDirOf(settings), 'App.axaml.cs');
        if (existsSync(appCs)) {
          const text = readFileSync(appCs, 'utf8');
          const hasStart = /CdpServer\.Start\s*\(/.test(text);
          push(hasStart, `App.axaml.cs 调用 CdpServer.Start: ${hasStart ? '是' : '否'}`, '在 OnFrameworkInitializationCompleted 的 Debug 分支里加 CdpServer.Start(9222)');
        } else {
          push(false, `App.axaml.cs: 缺失（${appCs}）`, '检查 appProjectDir 配置');
        }

        const exe = exePathOf(settings);
        push(existsSync(exe), `Debug exe: ${existsSync(exe) ? exe : '不存在'}`, 'avalonia_build');

        const s = await snapshot(settings);
        push(s.cdp.up, `CDP ${settings.cdpPort}: ${s.cdp.up ? '在听' : '不可达'}`, '以 Debug 运行应用（avalonia_launch）');
        push(s.appPids.length > 0, `应用进程: ${s.appPids.length ? `pid ${s.appPids.join(', ')}` : '未运行'}`, 'avalonia_launch');

        const lines = findings.map((f) => `${f.ok ? '✅' : '❌'} ${f.text}${f.ok ? '' : `\n   → ${f.fix}`}`);
        const bad = findings.filter((f) => !f.ok).length;
        return `${bad === 0 ? '全部检查通过。' : `${bad} 项需要处理。`}\n${lines.join('\n')}`;
      },
    }),
  );

  // ── 7. avalonia_guide ─────────────────────────────────────────────────────
  guard('avalonia_guide', () =>
    defineTool({
      name: 'avalonia_guide',
      description:
        'Return the selector conventions and known pitfalls for driving this Avalonia app over CDP. ' +
        'Read it before writing selectors; it explains the encoding trap, hidden pages, :nth-child, and how to assert the current page.',
      parameters: {},
      output: textOutput,
      async execute() {
        return [
          '【如何判断当前在哪一页】',
          '  dom_query "#PageHost" → attributes.text 就是当前 ViewModel 类型，例如',
          '  Kirara_Server_APP.ViewModels.Pages.HomeViewModel / MyAppsViewModel。',
          '',
          '【稳定选择器（已加 x:Name）】',
          '  导航: #NavHome #NavMyApps #NavStore #NavDownloads #NavSettings（折叠态另有 *Compact 后缀）',
          '  页面: #PageHost（ContentControl）',
          '  搜索: #AppSearchBox（我的应用页） #CatalogSearchBox（侧栏）',
          '  登录: #LoginUsernameBox #LoginPasswordBox #LoginButton',
          '',
          '【坑 1：中文选择器不可用】',
          '  Button[Text="我的应用"] 会被按 GBK 解码成乱码，匹配不到。',
          '  要么用上面这些 ASCII 的 #Name，要么在 evaluate 里用 \\u 转义写 JS。',
          '',
          '【坑 2：隐藏页面仍在 DOM 里】',
          '  登录页/注册页控件一直挂在树上，裸 Button 会命中隐藏元素并报 not visible。',
          '  一定要限定作用域：leftfunctionbar button:nth-child(3)、#PageHost ... 。',
          '',
          '【坑 3：只支持 :nth-child(n)，不支持 :nth(n)】',
          '  Button:nth(27) 会「5 秒内不可见」；用 tag:nth-child(k)。',
          '',
          '【坑 4：应用重启后 MCP 会掉线】',
          '  cdp-cli 只在启动时连一次 CDP，应用重启后报 Not connected to a target (ws is null)。',
          '  调 avalonia_reconnect（或 avalonia_restart）即可，不要重启 DSH。',
          '',
          '【evaluate 是 JS 不是 C#】',
          '  document.title、document.querySelectorAll('*').length 可用；',
          '  Application.Current... 会报 Application is not defined。',
          '  读控件属性用 dom_query（attributes 里有 Bounds/IsChecked/Text 等）。',
          '',
          '【典型循环】',
          '  改 XAML/VM → avalonia_build → avalonia_restart → dom_query "#PageHost" 断言页面',
          '  → screenshot 看渲染 → tap/input_text 走交互 → 再截图核对。',
        ].join('\n');
      },
    }),
  );
}
