import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { writeManaged, readManaged, assertPatchParseable, isProtected, isPendingLikeError, recordFailure, syncDisable } from '../src/index.mjs';

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

test('isPendingLikeError 判定', () => {
  assert.equal(isPendingLikeError('x: pending (waiting for service: typert)'), true);
  assert.equal(isPendingLikeError('x: did not activate'), true);
  assert.equal(isPendingLikeError('apply failed: boom'), false);
});
