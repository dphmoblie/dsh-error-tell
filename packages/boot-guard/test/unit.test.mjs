import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatchYaml } from '../src/yaml.mjs';
import { addQuarantine, restoreQuarantine, activeQuarantine, loadLedger } from '../src/quarantine.mjs';
import { readManaged, writeManaged } from '../src/patch-writer.mjs';
import { MANAGED_START, MANAGED_END } from '../src/home.mjs';
import { inferFailures, assertDisableLimit } from '../src/guard.mjs';

test('parsePatchYaml 容忍 !!js 表达式（dump-config 形态）', async () => {
  const text = [
    '- id: a',
    "  name: '@x/y'",
    "  config:",
    "    mode: !!js process.env.MODE",
    "    url: !!js >-",
    "      process.env.URL ??",
    "      'https://example.com'",
    "    list: !!js [1, 2]",
    '- id: b',
    "  disabled: true"
  ].join('\n');
  const rows = await parsePatchYaml(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'a');
  assert.ok(rows[0].config.mode.__jsExpr !== undefined || typeof rows[0].config.mode === 'string');
  assert.equal(rows[1].disabled, true);
});

test('quarantine 账本：add → active → restore', () => {
  const home = mkdtempSync(join(tmpdir(), 'det-ledger-'));
  addQuarantine(home, { rowId: 'r1', package: '@x/y', stage: 'import', error: 'boom', source: 'test' });
  assert.deepEqual(activeQuarantine(home).map(e => e.rowId), ['r1']);
  addQuarantine(home, { rowId: 'r1', stage: 'apply', error: 'boom2' });
  assert.equal(loadLedger(home).entries.filter(e => !e.restoredAt).length, 1);
  assert.ok(restoreQuarantine(home, 'r1'));
  assert.deepEqual(activeQuarantine(home), []);
});

test('patch-writer managed 段：创建/更新/保留用户内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'det-patch-'));
  const p = join(dir, 'cordis.patch.yml');
  writeFileSync(p, '# my comment\n- id: user-row\n  config: {a: 1}\n');
  writeManaged(p, ['r1']);
  let text = readFileSync(p, "utf8");
  assert.ok(text.includes('# my comment'));
  assert.ok(text.includes('- id: r1'));
  assert.ok(text.includes('disabled: true'));
  assert.ok(text.includes(MANAGED_START) && text.includes(MANAGED_END));
  writeManaged(p, ['r1', 'r2']);
  text = readFileSync(p, "utf8");
  assert.ok(text.includes('- id: r2'));
  assert.equal((text.match(/- id: r1/g) || []).length, 1, '不产生重复条目');
  writeManaged(p, []);
  text = readFileSync(p, 'utf8');
  assert.ok(!text.includes('- id: r1'));
  assert.ok(text.includes('# my comment'), '用户内容保留');
  // 空集合 + 文件不存在 → 不创建文件
  const p2 = join(dir, 'cordis2.patch.yml');
  writeManaged(p2, []);
  assert.throws(() => readFileSync(p2, 'utf8'));
  text = readFileSync(p, "utf8");
  assert.ok(!text.includes('- id: r1'));
  assert.ok(text.includes('# my comment'), '用户内容保留');
});

test('assertDisableLimit 熔断：超限抛错，限内通过', () => {
  assert.throws(() => assertDisableLimit(new Set(['a', 'b']), 1), /熔断/);
  assert.doesNotThrow(() => assertDisableLimit(new Set(['a', 'b']), 2));
  assert.doesNotThrow(() => assertDisableLimit(new Set(), 50));
});
test('inferFailures 从 stderr 归因行', () => {
  const rows = [
    { id: 'a', name: '@x/a' },
    { id: 'b', name: '@y/b' }
  ];
  assert.deepEqual(inferFailures('boom @y/b failed', rows), ['b']);
  assert.deepEqual(inferFailures('boom id: a', rows), ['a']);
  assert.deepEqual(inferFailures('boom x', rows), []);
  assert.deepEqual(inferFailures('nothing', rows), []);
});
