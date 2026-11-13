/**
 * 把本插件装进 DSH profile（幂等）。
 *
 *   node scripts/deploy.mjs --dry-run     # 只打印将要做的改动
 *   node scripts/deploy.mjs               # 写入 package.json + pnpm install + 挂进 bundles
 *   node scripts/deploy.mjs --disable     # 反挂（从 bundles 移除，保留依赖）
 *
 * 环境变量：
 *   DSH_HOME         默认 %USERPROFILE%\.dsh
 *   DSH_PROFILE_DIR  优先使用（DSH 内运行时会给出绝对路径）
 *   DSH_PNPM         指定 pnpm.cjs
 *
 * ⚠️ 安装后必须：
 *   1. 删掉 profile 的 cordis.patch.yml 里早期手工加的 `mcp-avalonia-cdp` insert 块
 *      （否则与插件的 bundle 同名 serverName 冲突）；
 *   2. 重启 DSH —— bundles 列表只在启动时读取。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = '@kirara/dsh-plugin-avalonia-mcp';
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const disable = args.has('--disable');

function fail(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR && existsSync(process.env.DSH_PROFILE_DIR)) {
    return process.env.DSH_PROFILE_DIR;
  }
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
  const profile = process.env.DSH_PROFILE || 'desktop';
  const dir = join(home, 'profiles', profile);
  if (!existsSync(dir)) fail(`找不到 profile 目录：${dir}（可设置 DSH_PROFILE_DIR）`);
  return dir;
}

function findPnpm() {
  if (process.env.DSH_PNPM && existsSync(process.env.DSH_PNPM)) return process.env.DSH_PNPM;
  const execDir = dirname(process.execPath);
  const candidates = [
    join(execDir, '..', 'product', 'd', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(execDir, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(execDir, '..', 'runtime', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return undefined;
}

const profileDir = resolveProfileDir();
const pkgPath = join(profileDir, 'package.json');
if (!existsSync(pkgPath)) fail(`找不到 ${pkgPath}`);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies ??= {};
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];

const fileSpec = 'file:' + PACKAGE_DIR.replace(/\\/g, '/');
const bundles = pkg.dsh.profile.bundles;

console.log(`插件目录: ${PACKAGE_DIR}`);
console.log(`profile : ${profileDir}`);
console.log(`当前依赖: ${pkg.dependencies[PLUGIN_NAME] || '（无）'}`);
console.log(`当前 bundles: ${bundles.includes(PLUGIN_NAME) ? '已包含' : '未包含'}`);

if (disable) {
  const next = bundles.filter((b) => b !== PLUGIN_NAME);
  if (next.length === bundles.length) {
    console.log('已经不在 bundles 里，无需改动。');
    process.exit(0);
  }
  pkg.dsh.profile.bundles = next;
  if (dryRun) {
    console.log('[dry-run] 将从 bundles 移除 ' + PLUGIN_NAME);
    process.exit(0);
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('✓ 已从 bundles 移除（依赖保留；重启 DSH 生效）');
  process.exit(0);
}

pkg.dependencies[PLUGIN_NAME] = fileSpec;
if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);

if (dryRun) {
  console.log('[dry-run] 将写入 package.json：');
  console.log('  dependencies["' + PLUGIN_NAME + '"] = "' + fileSpec + '"');
  console.log('  bundles += "' + PLUGIN_NAME + '"');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync(pkgPath, pkgPath + '.bak-' + stamp);
const lockPath = join(profileDir, 'pnpm-lock.yaml');
if (existsSync(lockPath)) copyFileSync(lockPath, lockPath + '.bak-' + stamp);
console.log('✓ 已备份 package.json / pnpm-lock.yaml（后缀 .bak-' + stamp + '）');

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('✓ package.json 已更新');

const pnpm = findPnpm();
if (!pnpm) fail('找不到 pnpm.cjs（设置 DSH_PNPM 指向它）');
console.log('pnpm: ' + pnpm);

const run = spawnSync(process.execPath, [pnpm, 'install', '--dir', profileDir, '--no-frozen-lockfile', '--reporter=append-only'], {
  stdio: 'inherit',
  env: process.env,
});
if (run.status !== 0) {
  console.error('✗ pnpm install 失败（退出码 ' + run.status + '），可用备份回滚：');
  console.error('  ' + pkgPath + '.bak-' + stamp);
  process.exit(run.status ?? 1);
}

const installed = join(profileDir, 'node_modules', ...PLUGIN_NAME.split('/'));
if (!existsSync(installed)) fail('pnpm 已结束但没看到安装目录：' + installed);
mkdirSync(dirname(installed), { recursive: true });
console.log('✓ 已安装到 ' + installed);

// file: 安装是**拷贝**，源码改过之后 pnpm 不一定会重新拷；这里强制同步一次，
// 保证「profile 里的副本」与「源码」逐字节一致（否则改了代码却跑旧实现）。
const installedLib = join(installed, 'lib');
mkdirSync(installedLib, { recursive: true });
for (const file of readdirSync(join(PACKAGE_DIR, 'lib'))) {
  copyFileSync(join(PACKAGE_DIR, 'lib', file), join(installedLib, file));
}
for (const file of ['package.json', 'cordis.patch.yml', 'README.md']) {
  const from = join(PACKAGE_DIR, file);
  if (existsSync(from)) copyFileSync(from, join(installed, file));
}
console.log('✓ 已同步 lib/ 与 cordis.patch.yml');

console.log('');
console.log('下一步：');
console.log('  1. 删除 profile 的 cordis.patch.yml 里早期手工加的 mcp-avalonia-cdp insert 块');
console.log('  2. 重启 DSH（bundles 只在启动时读取）');
console.log('  3. 重启后应看到 mcp__avalonia__* 与 avalonia_* 两套工具');
