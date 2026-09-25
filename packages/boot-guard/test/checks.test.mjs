// runChecks 重构的回归测试：结果顺序、唯一包去重、并发限流、跳过规则。
// 用可注入 runner 替代真实子进程干跑，因此不需要 spawn（沙箱/CI 友好）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks, clearImportCache, hasHostEntry, isTargetUnresolved, resolutionNames, checkImport } from '../src/checks.mjs';

/** 造一个可被 createRequire/import 解析的假包。 */
function mkPkg(rootDir, name, files) {
  const dir = join(rootDir, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', ...(files.pkg || { main: 'index.js' }) }), 'utf8');
  writeFileSync(join(dir, files.entry || 'index.js'), files.code, 'utf8');
  return dir;
}

test('runChecks：import 结果按原行顺序回放，同一包只干跑一次', async () => {
  clearImportCache();
  const calls = [];
  const runner = async (name) => {
    calls.push(name);
    return name === '@x/bad' ? { ok: false, stage: 'import', error: 'boom ' + name } : { ok: true };
  };
  const rows = [
    { id: 'a', name: '@x/ok' },
    { id: 'b', name: '@x/bad' },
    { id: 'c', name: '@x/ok' },   // 与 a 同包 → 复用结果
    { id: 'd', name: '@x/bad' }   // 与 b 同包 → 复用结果，但仍要为该行产出 issue
  ];
  const issues = await runChecks(rows, { runner });
  assert.deepEqual(calls, ['@x/ok', '@x/bad'], '唯一包各干跑一次');
  assert.deepEqual(issues.map(i => i.rowId), ['b', 'd'], '两个失败行都产出 issue 且按行顺序');
  assert.ok(issues.every(i => i.severity === 'error' && i.stage === 'import' && i.package === '@x/bad'));
});

test('runChecks：并发受限（concurrency），不再逐行串行', async () => {
  clearImportCache();
  let inFlight = 0;
  let maxInFlight = 0;
  const runner = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 15));
    inFlight--;
    return { ok: true };
  };
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, name: '@x/p' + i }));
  const issues = await runChecks(rows, { runner, concurrency: 3 });
  assert.equal(issues.length, 0, '全部通过时无 issue');
  assert.ok(maxInFlight <= 3, '并发不超过 concurrency=3，实际 ' + maxInFlight);
  assert.ok(maxInFlight > 1, '确实发生了并行（原串行实现 maxInFlight 恒为 1），实际 ' + maxInFlight);
});

test('runChecks：静态错误与 import 错误按行顺序交错产出', async () => {
  clearImportCache();
  const runner = async (name) => (name === '@x/bad' ? { ok: false, stage: 'import', error: 'boom' } : { ok: true });
  const rows = [
    { id: 'a', name: '@x/bad' },
    { id: 'b' },                  // 缺 name → config error
    { id: 'b', name: '@x/dup' },  // 重复 id → config error
    { id: 'c', name: '@x/ok' }
  ];
  const issues = await runChecks(rows, { runner });
  assert.deepEqual(issues.map(i => [i.rowId, i.stage, i.severity]), [
    ['a', 'import', 'error'],
    ['b', 'config', 'error'],
    ['b', 'config', 'error']
  ]);
});

test('runChecks：disabled / skipPackages / importChecks=false 都不触发干跑', async () => {
  clearImportCache();
  const calls = [];
  const runner = async (n) => { calls.push(n); return { ok: true }; };
  await runChecks([
    { id: 'a', name: '@x/a', disabled: true },
    { id: 'b', name: '@x/b' }
  ], { runner, skipPackages: ['@x/b'] });
  assert.deepEqual(calls, [], 'disabled 与 skipPackages 行都跳过干跑');
  await runChecks([{ id: 'c', name: '@x/c' }], { runner, importChecks: false });
  assert.deepEqual(calls, [], 'importChecks=false 全部跳过');
});

test('runChecks：runner 抛错时降级为 spawn issue，不炸掉整次预检', async () => {
  clearImportCache();
  const runner = async () => { throw new Error('kaboom'); };
  const issues = await runChecks([{ id: 'a', name: '@x/throw' }], { runner });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].stage, 'spawn');
  assert.match(issues[0].message, /kaboom/);
});

// ---------- P2-15：exports 形态 ----------
test('hasHostEntry：兼容各种合法 exports 写法（P2-15 回归）', () => {
  assert.equal(hasHostEntry({ main: './index.js' }), true);
  assert.equal(hasHostEntry({ module: './index.mjs' }), true);
  assert.equal(hasHostEntry({ exports: './index.js' }), true, 'exports 字符串');
  assert.equal(hasHostEntry({ exports: ['./index.js'] }), true, 'exports 数组');
  assert.equal(hasHostEntry({ exports: { '.': './index.js' } }), true, 'exports["."] 字符串');
  assert.equal(hasHostEntry({ exports: { '.': { import: './i.js', require: './c.js' } } }), true, 'exports["."] 条件导出');
  assert.equal(hasHostEntry({ exports: { import: './i.js', default: './d.js' } }), true, '条件导出写在顶层');
  assert.equal(hasHostEntry({ exports: { './sub': './sub.js' } }), false, '只有子路径导出 → 无 host 入口');
  assert.equal(hasHostEntry({}), false);
  assert.equal(hasHostEntry(null), false);
});

// ---------- P1-3：回退条件 ----------
test('isTargetUnresolved：只有「目标包本身找不到」才算，内部依赖缺失不算（P1-3 回归）', () => {
  const target = "Cannot find package '@x/target' imported from /p/[eval1]";
  const transitive = "Cannot find package 'lodash' imported from /p/node_modules/@x/target/index.js";
  assert.equal(isTargetUnresolved(target, '@x/target'), true);
  assert.equal(isTargetUnresolved(transitive, '@x/target'), false, '内部依赖缺失不得触发回退');
  assert.equal(isTargetUnresolved("Cannot find module '@x/target'", '@x/target'), true);
  assert.equal(isTargetUnresolved('some other error', '@x/target'), false);

  // 真实 Node 报错形态（带 ERR_MODULE_NOT_FOUND 前缀 + `imported from <路径>`）：
  // Linux/macOS 路径用正斜杠，路径段里就带着目标包名，旧正则 `ERR_MODULE_NOT_FOUND[^\n]*<name>`
  // 会误判成「目标包解析不到」。Windows 因路径用反斜杠而侥幸通过 —— 该回归由 ubuntu CI 抓出。
  const realTransitive = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'definitely-missing-dep' imported from /tmp/x/node_modules/@x/target/index.js";
  assert.equal(isTargetUnresolved(realTransitive, '@x/target'), false, '路径里的包名不得被当成缺失说明符');
  const realTarget = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@x/target' imported from /tmp/x/[eval1]";
  assert.equal(isTargetUnresolved(realTarget, '@x/target'), true, '真的缺失时仍必须回退');
});

// ---------- P1-3 补丁：子路径 spec（@scope/pkg/sub，如 dsh-base 的 …-subagent-control/list-agents） ----------
test('isTargetUnresolved：行 name 带子路径时，Node 报的是包根名也必须判为「目标解析不到」', () => {
  // 真实形态：name = '@deepseek-ai/dsh-tool-subagent-control/list-agents'，
  // 包缺失时 Node 只把**包根名**放进引号 → 只比对完整 spec 会漏判 → 不回退 → 官方行被误报。
  const real = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tool-subagent-control' imported from C:\\tmp\\profiles\\s2g\\[eval1]";
  assert.equal(isTargetUnresolved(real, '@deepseek-ai/dsh-tool-subagent-control/list-agents'), true);
  assert.equal(isTargetUnresolved("Cannot find module 'plain-pkg'", 'plain-pkg/sub'), true);

  // 不得放宽：内部传递依赖缺失时报的是**别的**包名，两个候选都命中不了。
  const transitive = "Cannot find package 'lodash' imported from /p/node_modules/@x/target/index.js";
  assert.equal(isTargetUnresolved(transitive, '@x/target/sub'), false, '内部依赖缺失仍不得回退');
});

test('resolutionNames：完整 spec + 带子路径时的包根名', () => {
  assert.deepEqual(resolutionNames('@a/b/c'), ['@a/b/c', '@a/b']);
  assert.deepEqual(resolutionNames('@a/b'), ['@a/b']);
  assert.deepEqual(resolutionNames('a/b'), ['a/b', 'a']);
  assert.deepEqual(resolutionNames('plain'), ['plain']);
  assert.deepEqual(resolutionNames(''), ['']);
});

test('checkImport：profile 内目标包存在但内部依赖缺失时不得回退到 dshInstall（P1-3 端到端回归）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'det-fallback-'));
  const profileDir = join(root, 'profile');
  const dshInstall = join(root, 'global');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dshInstall, { recursive: true });
  // profile 里：目标包存在，但内部 import 了一个不存在的依赖
  mkPkg(profileDir, '@x/broken', { code: "import 'definitely-missing-dep';\nexport default {};\n" });
  // 全局安装里：同名且健康的包（原实现会回退到这里 → 误判成功）
  mkPkg(dshInstall, '@x/broken', { code: 'export default {};\n' });

  const res = await checkImport('@x/broken', [profileDir, dshInstall], 20000);
  assert.equal(res.ok, false, '必须报告失败，而不是被全局同名包掩盖');
  assert.match(String(res.error), /definitely-missing-dep/, '错误应指向真正缺失的内部依赖');
  rmSync(root, { recursive: true, force: true });
});

test('checkImport：目标包在 profile 与全局都找不到时，才回退并最终报「无法解析」', async () => {
  const root = mkdtempSync(join(tmpdir(), 'det-fallback2-'));
  const profileDir = join(root, 'profile');
  const dshInstall = join(root, 'global');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dshInstall, { recursive: true });
  // 只在全局安装里存在 → 应回退成功命中
  mkPkg(dshInstall, '@x/only-global', { code: 'export default {};\n' });
  const hit = await checkImport('@x/only-global', [profileDir, dshInstall], 20000);
  assert.equal(hit.ok, true, '目标包确实不存在于 profile 时应回退到 dshInstall');

  const miss = await checkImport('@x/nowhere', [profileDir, dshInstall], 20000);
  assert.equal(miss.ok, false);
  assert.equal(miss.stage, 'import');
  rmSync(root, { recursive: true, force: true });
});

// ---------- P2-11 / P2-10：干跑判定与超时 ----------
test('checkImport：目标包先打印 OK 再抛错，必须判为失败（P2-11 回归）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'det-okthrow-'));
  mkPkg(root, '@x/ok-then-throw', { code: "console.log('OK');\nthrow new Error('boom after OK');\n" });
  const res = await checkImport('@x/ok-then-throw', [root], 20000);
  assert.equal(res.ok, false, '原实现只要 stdout 含 OK 就判成功，会被这里骗过');
  rmSync(root, { recursive: true, force: true });
});

test('checkImport：正常包判成功；挂起包走上限超时且不挂死（P2-10 回归）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'det-timeout-'));
  mkPkg(root, '@x/good', { code: 'export default {};\n' });
  assert.equal((await checkImport('@x/good', [root], 20000)).ok, true);

  // 注意：不能写 `await new Promise(() => {})`——那种顶层 await 不保持事件循环，
  // Node 会以 exit 13（unsettled top-level await）直接退出，根本不会挂起。
  // 用一个长定时器保持事件循环，才是真正的「卡住」。
  mkPkg(root, '@x/hang', { code: 'await new Promise(r => setTimeout(r, 60000));\n' });
  const started = Date.now();
  const res = await checkImport('@x/hang', [root], 1500);
  assert.equal(res.stage, 'timeout', '挂起包必须报 timeout');
  assert.match(String(res.error), /重试 1 次后仍超时/, '两次都超时才上报，错误里应写明重试过');
  assert.ok(Date.now() - started < 15000, '不应挂死（实际 ' + (Date.now() - started) + 'ms）');
  rmSync(root, { recursive: true, force: true });
});

test('checkImport：首次超时后重试一次（负载抖动的假失败不得凭空记账/禁用）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'det-retry-'));
  const marker = join(root, 'hang-marker');
  writeFileSync(marker, '1');
  // 模块只在 marker 存在时挂起：第一次超时后由测试删掉 marker，重试即成功。
  mkPkg(root, '@x/flaky', {
    code: "import { existsSync } from 'node:fs';\n" +
      "if (existsSync(process.env.DET_TEST_HANG_MARKER)) await new Promise(r => setTimeout(r, 60000));\n" +
      'export default {};\n'
  });
  const prev = process.env.DET_TEST_HANG_MARKER;
  process.env.DET_TEST_HANG_MARKER = marker;
  try {
    const p = checkImport('@x/flaky', [root], 1500);
    // 关键时序：第一次尝试在 t≈300ms 读到 marker（挂起），marker 必须在 1500ms 那次超时**之前**删除，
    // 这样重试（t≈1500ms 起）才读到「无 marker」并成功。删太晚会让重试也挂起 → 假失败。
    setTimeout(() => rmSync(marker, { force: true }), 700);
    const res = await p;
    assert.equal(res.ok, true, '第一次超时后必须重试，marker 消失后应判成功');
  } finally {
    if (prev === undefined) delete process.env.DET_TEST_HANG_MARKER; else process.env.DET_TEST_HANG_MARKER = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
