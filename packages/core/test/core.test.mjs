import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { writeManaged, readManaged, assertPatchParseable, isProtected, isPendingLikeError, isEnvError, recordFailure, syncDisable, loadLedger, saveLedger, addQuarantine, withFileLock, nonNegativeInt, isValidRowId, lastCorruptLedgerBackup, quarantinePath } from '../src/index.mjs';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml');
function tmpDir() { return mkdtempSync(join(tmpdir(), 'det-core-')); }
function parse(text) { return yaml.load(text); }

test('writeManaged：空数组 [] 文件写入后仍是单一合法顶层数组（事故场景）', () => {
  const dir = tmpDir();
  const p = join(dir, 'cordis.patch.yml');
  writeFileSync(p, '[]\n', 'utf8');
  writeManaged(p, ['typert']);
  const text = readFileSync(p, 'utf8');
  const arr = parse(text);
  assert.ok(Array.isArray(arr), '必须是顶层数组');
  assert.ok(arr.some(e => e.id === 'typert' && e.disabled === true), '含 managed 条目');
  rmSync(dir, { recursive: true, force: true });
});

test('writeManaged：含用户条目的文件写入后保留用户条目（同一数组）', () => {
  const dir = tmpDir();
  const p = join(dir, 'cordis.patch.yml');
  writeFileSync(p, '# user comment\n- id: user-row\n  config: {a: 1}\n', 'utf8');
  writeManaged(p, ['x-bad']);
  const text = readFileSync(p, 'utf8');
  const arr = parse(text);
  assert.ok(Array.isArray(arr));
  assert.ok(arr.some(e => e.id === 'user-row'), '用户条目保留');
  assert.ok(arr.some(e => e.id === 'x-bad' && e.disabled === true), 'managed 条目加入同一数组');
  assert.ok(text.includes('# user comment'), '用户注释保留');
  rmSync(dir, { recursive: true, force: true });
});

test('writeManaged：顶层非数组文档拒绝写入（不覆盖损坏配置）', () => {
  const dir = tmpDir();
  const p = join(dir, 'cordis.patch.yml');
  writeFileSync(p, 'key: value\n', 'utf8');
  assert.throws(() => writeManaged(p, ['x']), /拒绝写入/);
  assert.equal(readFileSync(p, 'utf8'), 'key: value\n', '原文件未变');
  rmSync(dir, { recursive: true, force: true });
});

test('writeManaged：纯注释文件写入后是合法数组', () => {
  const dir = tmpDir();
  const p = join(dir, 'cordis.patch.yml');
  writeFileSync(p, '# only comments\n', 'utf8');
  writeManaged(p, ['x-bad']);
  const arr = parse(readFileSync(p, 'utf8'));
  assert.ok(Array.isArray(arr) && arr.some(e => e.id === 'x-bad'));
  rmSync(dir, { recursive: true, force: true });
});

test('assertPatchParseable：损坏文件抛错，缺失/合法文件通过', () => {
  const dir = tmpDir();
  const p = join(dir, 'cordis.patch.yml');
  assert.doesNotThrow(() => assertPatchParseable(join(dir, 'missing.yml')));
  writeFileSync(p, '::::broken::::', 'utf8');
  assert.throws(() => assertPatchParseable(p), /拒绝任何 managed 写入/);
  writeFileSync(p, '[]', 'utf8');
  assert.doesNotThrow(() => assertPatchParseable(p));
  rmSync(dir, { recursive: true, force: true });
});

test('isProtected：核心服务受保护，测试 fixture 不受保护', () => {
  assert.equal(isProtected('typert', '@deepseek-ai/dsh-typert-registry'), true);
  assert.equal(isProtected('api-gateway', undefined), true);
  assert.equal(isProtected('workspace', undefined), true);
  assert.equal(isProtected('include', undefined), true);
  assert.equal(isProtected('fixture-bad-apply', '@dsh-error-tell/fixture-bad-apply'), false);
  assert.equal(isProtected('ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'), false, 'UI 行可禁用');
});

test('recordFailure：保护名单命中只记账不写 managed；pending 错误不记录', () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  const p = join(home, 'cordis.patch.yml');
  const logs = [];
  const ok1 = recordFailure(home, p, { rowId: 'typert', pkg: '@deepseek-ai/dsh-typert-registry', stage: 'apply', error: 'boom', log: m => logs.push(m) });
  assert.equal(ok1, false, 'protected 不写 managed');
  assert.ok(!existsSync(p), '未创建 patch');
  // pending 用独立目录（避免 protected 已写账本污染断言）
  const home2 = join(dir, 'home2');
  const p2 = join(home2, 'cordis.patch.yml');
  const ok2 = recordFailure(home2, p2, { rowId: 'some-ui', pkg: '@x/ui', stage: 'apply', error: 'pending (waiting for service: typert)' });
  assert.equal(ok2, false, 'pending 不记录');
  assert.ok(!existsSync(join(home2, 'state', 'dsh-error-tell', 'quarantine.json')), 'pending 未写账本');
  rmSync(dir, { recursive: true, force: true });
});

test('isEnvError 判定', () => {
  assert.equal(isEnvError('EADDRINUSE: address already in use 127.0.0.1:3080'), true);
  assert.equal(isEnvError('Error: cannot create effect on inactive context'), true);
  assert.equal(isEnvError('task-board ledger is already owned by process 36980'), true);
  assert.equal(isEnvError('apply failed: boom'), false);
});

test('recordFailure：环境类错误只记账 -env；批量达到阈值只记账 -batch', () => {
  const dir = tmpDir();
  const home = join(dir, 'home');
  const p = join(home, 'cordis.patch.yml');
  const logs = [];
  // 环境错误
  const ok1 = recordFailure(home, p, { rowId: 'ui-x', pkg: '@x/ui', stage: 'apply', error: 'EADDRINUSE: address already in use', log: m => logs.push(m) });
  assert.equal(ok1, false, '环境错误不禁用');
  assert.ok(!existsSync(p), '未写 managed');
  // 批量阈值（batchCount >= 5）
  const ok2 = recordFailure(home, p, { rowId: 'ui-y', pkg: '@x/ui2', stage: 'apply', error: 'boom', batchCount: 5, log: m => logs.push(m) });
  assert.equal(ok2, false, '批量熔断不禁用');
  assert.ok(!existsSync(p), '批量熔断未写 managed');
  // 账本应记录两条（-env 与 -batch）
  const ledger = JSON.parse(readFileSync(join(home, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
  const sources = ledger.entries.map(e2 => e2.source);
  assert.ok(sources.includes('runtime-guard-env') && sources.includes('runtime-guard-batch'), 'source 标注正确: ' + sources.join(','));
  rmSync(dir, { recursive: true, force: true });
});

test('isPendingLikeError 判定', () => {
  assert.equal(isPendingLikeError('x: pending (waiting for service: typert)'), true);
  assert.equal(isPendingLikeError('x: did not activate'), true);
  assert.equal(isPendingLikeError('apply failed: boom'), false);
});

// ---------- P1-6：全新 DSH_HOME ----------
test('writeManaged：patch 与父目录都不存在时自动创建（P1-6 全新 DSH_HOME 回归）', () => {
  const dir = tmpDir();
  const p = join(dir, 'brand-new', 'nested', 'cordis.patch.yml');
  assert.ok(!existsSync(join(dir, 'brand-new')), '前置：父目录确实不存在');
  writeManaged(p, ['x-bad']);
  assert.ok(existsSync(p), '应自动创建目录并写出文件');
  assert.ok(readFileSync(p, 'utf8').includes('- id: x-bad'));
  rmSync(dir, { recursive: true, force: true });
});

// ---------- P1-7：损坏账本 ----------
test('loadLedger：损坏的账本会先备份再重置，不静默丢弃（P1-7 回归）', () => {
  const home = tmpDir();
  const p = quarantinePath(home);
  writeManaged(p, []); // 建立父目录
  writeFileSync(p, '{ 这不是合法 JSON', 'utf8');
  const led = loadLedger(home);
  assert.deepEqual(led.entries, [], '损坏时返回空账本以便继续运行');
  const backup = lastCorruptLedgerBackup();
  assert.ok(backup && existsSync(backup), '必须留下备份：' + backup);
  assert.equal(readFileSync(backup, 'utf8'), '{ 这不是合法 JSON', '备份内容与原文一致');
  rmSync(home, { recursive: true, force: true });
});

test('loadLedger：结构非法（entries 不是数组）同样走备份路径；不存在的文件才是空账本', () => {
  const home = tmpDir();
  assert.deepEqual(loadLedger(home).entries, [], '文件不存在 → 空账本');
  const p = quarantinePath(home);
  writeManaged(p, []);
  writeFileSync(p, '{"version":1,"entries":"oops"}', 'utf8');
  assert.deepEqual(loadLedger(home).entries, []);
  assert.ok(lastCorruptLedgerBackup() && existsSync(lastCorruptLedgerBackup()), '结构非法也要备份');
  rmSync(home, { recursive: true, force: true });
});

// ---------- P2-9：整数解析 ----------
test('nonNegativeInt：NaN / 负数 / 小数 / 空值回退默认，避免熔断被击穿（P2-9 回归）', () => {
  assert.equal(nonNegativeInt('abc', 5), 5);
  assert.equal(nonNegativeInt('', 5), 5);
  assert.equal(nonNegativeInt(undefined, 5), 5);
  assert.equal(nonNegativeInt('-1', 5), 5);
  assert.equal(nonNegativeInt('1.5', 5), 5, '小数不是合法整数配置');
  assert.equal(nonNegativeInt('0', 5), 0, '0 是合法值');
  assert.equal(nonNegativeInt('7', 5), 7);
  assert.equal(nonNegativeInt(7, 5), 7);
});

// ---------- P2-17：rowId 校验 ----------
test('isValidRowId / syncDisable：拒绝会破坏 YAML 或超长的行 id（P2-17 回归）', () => {
  assert.equal(isValidRowId('fixture-bad-apply'), true);
  assert.equal(isValidRowId('@scope/pkg:child'), true);
  assert.equal(isValidRowId('a'.repeat(200)), true);
  assert.equal(isValidRowId('a'.repeat(201)), false, '超长拒绝');
  assert.equal(isValidRowId('bad id'), false, '空格拒绝');
  assert.equal(isValidRowId('bad\nid'), false, '换行拒绝');
  assert.equal(isValidRowId("#inject"), false, 'YAML 注释符拒绝');
  assert.equal(isValidRowId('a: b'), false);
  assert.equal(isValidRowId(123), false, '非字符串拒绝');

  const dir = tmpDir();
  const p = join(dir, 'cordis.patch.yml');
  assert.throws(() => syncDisable(p, 'bad id'), /非法的行 id/);
  assert.throws(() => syncDisable(p, 'a'.repeat(201)), /非法的行 id/);
  assert.ok(!existsSync(p), '拒绝时不应写出任何文件');
  rmSync(dir, { recursive: true, force: true });
});

// ---------- P1-4：跨进程互斥 ----------
test('withFileLock：同一路径不可重入（第二次获取超时抛错），释放后可再获取', () => {
  const dir = tmpDir();
  const lock = join(dir, 'x.lock');
  withFileLock(lock, () => {
    assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 50 }), /获取文件锁超时/);
  });
  assert.doesNotThrow(() => withFileLock(lock, () => {}, { timeoutMs: 50 }), '释放后应能再次获取');
  rmSync(dir, { recursive: true, force: true });
});

test('withFileLock：并发写者持锁放大窗口也不丢失更新（P1-4 跨进程回归）', async () => {
  const N = 6;
  const home = tmpDir();
  const worker = join(home, 'worker.mjs');
  const core = pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.mjs')).href;
  writeFileSync(worker, [
    `import { withFileLock, loadLedger, saveLedger, quarantinePath } from ${JSON.stringify(core)};`,
    'const [home, i] = process.argv.slice(2);',
    "withFileLock(quarantinePath(home) + '.lock', () => {",
    '  const led = loadLedger(home);',
    '  const end = Date.now() + 40; while (Date.now() < end) { /* 持锁期间放大窗口 */ }',
    "  led.entries.push({ rowId: 'r' + i, failCount: 1 });",
    '  saveLedger(home, led);',
    '});'
  ].join('\n'), 'utf8');

  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [worker, home, String(i)], { stdio: 'ignore' });
    c.on('close', res);
    c.on('error', res);
  })));

  const entries = loadLedger(home).entries;
  assert.equal(entries.length, N, '持锁后并发写入不应丢失任何一条，实际 ' + entries.length + '/' + N);
  rmSync(home, { recursive: true, force: true });
});

test('addQuarantine：并发调用（真实路径）不丢失条目', async () => {
  const N = 6;
  const home = tmpDir();
  const worker = join(home, 'worker.mjs');
  const core = pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.mjs')).href;
  writeFileSync(worker, [
    `import { addQuarantine } from ${JSON.stringify(core)};`,
    'const [home, i] = process.argv.slice(2);',
    "addQuarantine(home, { rowId: 'row-' + i, stage: 'import', error: 'boom', source: 'race' });"
  ].join('\n'), 'utf8');

  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [worker, home, String(i)], { stdio: 'ignore' });
    c.on('close', res);
    c.on('error', res);
  })));

  assert.equal(loadLedger(home).entries.length, N, 'addQuarantine 并发写不应丢失条目');
  rmSync(home, { recursive: true, force: true });
});
