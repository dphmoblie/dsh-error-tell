// runtime-guard 熔断语义单测：countManaged 统计 / recordFailure 账本必写 + managed 上限熔断
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countManaged, recordFailure, syncDisable } from '../src/index.mjs';

const MANAGED_HEAD = '# --- dsh-error-tell managed (auto-generated; do not edit) ---';
const MANAGED_END = '# --- end dsh-error-tell managed ---';

function tmpHome() {
  const d = mkdtempSync(join(tmpdir(), 'det-rg-'));
  return { home: d, patch: join(d, 'cordis.patch.yml'), cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('countManaged：空/无段文件为 0，managed 段按行计数', () => {
  const { home, patch, cleanup } = tmpHome();
  try {
    assert.equal(countManaged(patch), 0, '文件不存在 → 0');
    writeFileSync(patch, '::::broken::::', 'utf8');
    assert.equal(countManaged(patch), 0, '无 managed 段 → 0');
    writeFileSync(patch, [MANAGED_HEAD, '- id: a', '- id: b', '- id: c', MANAGED_END, ''].join('\n'), 'utf8');
    assert.equal(countManaged(patch), 3, '3 个 id 行 → 3');
  } finally { cleanup(); }
});

test('recordFailure：未达上限时账本写入且 managed 追加禁用行', () => {
  const { home, patch, cleanup } = tmpHome();
  try {
    syncDisable(patch, 'already-disabled');
    const ok = recordFailure(home, patch, { rowId: 'new-bad', pkg: '@scope/new-bad', stage: 'apply', error: 'boom' });
    assert.equal(ok, true);
    assert.ok(readFileSync(patch, 'utf8').includes('- id: new-bad'), 'managed 段含新禁用行');
    const ledger = JSON.parse(readFileSync(join(home, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
    assert.ok(ledger.entries.some(e => e.rowId === 'new-bad' && e.source === 'runtime-guard'), '账本含活动条目');
  } finally { cleanup(); }
});

test('recordFailure：达上限（maxDisable）时账本仍写但跳过 managed 禁用', () => {
  const { home, patch, cleanup } = tmpHome();
  try {
    syncDisable(patch, 'one');
    const logs = [];
    const ok = recordFailure(home, patch, { rowId: 'two', pkg: '@scope/two', stage: 'import', error: 'import boom', maxDisable: 1, log: (m) => logs.push(m) });
    assert.equal(ok, false, '达到上限 → 返回 false');
    const text = readFileSync(patch, 'utf8');
    assert.ok(!text.includes('- id: two'), 'managed 段不新增行');
    assert.ok(text.includes('- id: one'), '既有禁用行保留');
    const ledger = JSON.parse(readFileSync(join(home, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
    assert.ok(ledger.entries.some(e => e.rowId === 'two'), '账本仍记录（可审计）');
    assert.ok(logs.some(m => m.includes('熔断')), '输出熔断日志');
  } finally { cleanup(); }
});
