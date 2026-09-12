// runtime-guard 熔断语义单测：countManaged 统计 / recordFailure 账本必写 + managed 上限熔断
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countManaged, recordFailure, syncDisable, resetRunDisabled, culpritOf, stageOf, rollbackWritten, apply } from '../src/index.mjs';
import { readManaged, activeQuarantine } from '@dsh-error-tell/core';

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

test('culpritOf：从 cause 链归因到最深层肇事条目，而不是级联受害者 include（实测场景回归）', () => {
  // 构造与 dsh updateError 完全一致的包裹链（本机 0.1.5-alpha.1 实测形态）
  const inner = new Error('[dsh-error-tell] fixture: import 阶段抛错（用于测试）');
  const mid = new Error(
    'failed to import loader entry fixture-bad-import (@dsh-error-tell/fixture-bad-import): [dsh-error-tell] fixture: import 阶段抛错（用于测试）',
    { cause: inner }
  );
  const outer = new Error(
    'failed to apply loader entry include (cordis:include): failed to import loader entry fixture-bad-import (@dsh-error-tell/fixture-bad-import): [dsh-error-tell] fixture: import 阶段抛错（用于测试）',
    { cause: mid }
  );
  assert.deepEqual(culpritOf(outer), {
    stage: 'import',
    rowId: 'fixture-bad-import',
    name: '@dsh-error-tell/fixture-bad-import'
  }, '最深层的条目才是真凶');
});

test('culpritOf：apply 阶段与无 cause 链的情形', () => {
  const applyErr = new Error('failed to apply loader entry fixture-bad-apply (@dsh-error-tell/fixture-bad-apply): boom');
  assert.deepEqual(culpritOf(applyErr), { stage: 'apply', rowId: 'fixture-bad-apply', name: '@dsh-error-tell/fixture-bad-apply' });
  assert.equal(culpritOf(new Error('apply failed: boom')), null, '无 loader entry 信息 → null（调用方回退到 fallback id）');
  assert.equal(culpritOf(undefined), null);
  assert.equal(culpritOf(null), null);
});

test('culpritOf：cause 链成环时不无限循环', () => {
  const a = new Error('failed to import loader entry x (@s/x): boom');
  a.cause = a; // 自环
  assert.deepEqual(culpritOf(a), { stage: 'import', rowId: 'x', name: '@s/x' });
});

test('stageOf：仅用于无 cause 链时的阶段兜底', () => {
  assert.equal(stageOf(new Error('failed to import loader entry x (@s/x): boom')), 'import');
  assert.equal(stageOf(new Error('failed to apply loader entry x (@s/x): boom')), 'apply');
  assert.equal(stageOf(new Error('something else')), 'apply');
});

test('recordFailure：熔断按「本次运行新增」计数，历史遗留禁用行不再造成自锁（S3 回归）', () => {
  const { home, patch, cleanup } = tmpHome();
  try {
    // 用户此前已有 5 个合法禁用行（等于 maxDisable 默认值）
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) syncDisable(patch, id);
    resetRunDisabled(patch);
    const logs = [];
    const ok = recordFailure(home, patch, { rowId: 'new-bad', pkg: '@scope/new-bad', stage: 'apply', error: 'boom', maxDisable: 5, log: (m) => logs.push(m) });
    assert.equal(ok, true, '历史 5 行不该锁死熔断：本次只新增 1 行，应当禁用');
    assert.ok(readFileSync(patch, 'utf8').includes('- id: new-bad'), 'managed 段新增禁用行');
    assert.equal(countManaged(patch), 6, '历史 5 行 + 新增 1 行');
  } finally { cleanup(); }
});

test('recordFailure：本次运行新增达到上限时熔断，账本仍写但跳过 managed 禁用', () => {
  const { home, patch, cleanup } = tmpHome();
  try {
    resetRunDisabled(patch);
    const logs = [];
    // 第一次新增：允许（本次运行 0 → 1）
    const ok1 = recordFailure(home, patch, { rowId: 'bad-1', pkg: '@scope/bad-1', stage: 'import', error: 'import boom', maxDisable: 1, log: (m) => logs.push(m) });
    assert.equal(ok1, true, '本次运行第 1 个新增 → 允许');
    // 第二次新增：熔断（本次运行已达上限 1）
    const ok2 = recordFailure(home, patch, { rowId: 'bad-2', pkg: '@scope/bad-2', stage: 'import', error: 'import boom', maxDisable: 1, log: (m) => logs.push(m) });
    assert.equal(ok2, false, '本次运行新增达上限 → 返回 false');
    const text = readFileSync(patch, 'utf8');
    assert.ok(text.includes('- id: bad-1'), '已有新增行保留');
    assert.ok(!text.includes('- id: bad-2'), '熔断行不写入 managed');
    const ledger = JSON.parse(readFileSync(join(home, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
    assert.ok(ledger.entries.some(e => e.rowId === 'bad-2'), '账本仍记录（可审计）');
    assert.ok(logs.some(m => m.includes('熔断')), '输出熔断日志');
  } finally { cleanup(); }
});

// ---------- P1-5：批量回滚只撤本进程写入的行 ----------
test('rollbackWritten：只回滚本进程写入的 id，历史禁用项必须原样保留（P1-5 回归）', () => {
  const { home, patch, cleanup } = tmpHome();
  try {
    // 历史遗留（上一个进程写的）
    syncDisable(patch, 'historical-bad');
    // 本进程写入的
    syncDisable(patch, 'mine-1');
    syncDisable(patch, 'mine-2');

    const rolled = rollbackWritten(home, patch, new Set(['mine-1', 'mine-2']));
    assert.deepEqual(rolled.sort(), ['mine-1', 'mine-2'], '只回滚本进程的两个');
    const ids = [...readManaged(patch).ids];
    assert.ok(ids.includes('historical-bad'), '历史禁用项绝不能被批量熔断误恢复，实际: ' + ids.join(','));
    assert.ok(!ids.includes('mine-1') && !ids.includes('mine-2'), '本进程写入的应被撤销');
  } finally { cleanup(); }
});

test('rollbackWritten：空集合时不动任何配置', () => {
  const { home, patch, cleanup } = tmpHome();
  try {
    syncDisable(patch, 'keep-me');
    assert.deepEqual(rollbackWritten(home, patch, new Set()), []);
    assert.ok(readManaged(patch).ids.has('keep-me'));
  } finally { cleanup(); }
});

// ---------- P2-8：seen 去重时机 ----------
function mockCtx() {
  const handlers = new Map();
  const logs = [];
  return {
    logs,
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, []); handlers.get(evt).push(fn); },
    loader: { entries: () => [] },
    logger: { error: (m) => logs.push(String(m)), info: () => {} },
    fire(evt, ...args) { for (const fn of handlers.get(evt) || []) fn(...args); }
  };
}

test('apply：先来的 pending 事件不得占用去重位，后续真实失败仍要处理（P2-8 回归）', () => {
  const { home, patch, cleanup } = tmpHome();
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  resetRunDisabled(patch);
  try {
    const ctx = mockCtx();
    apply(ctx);
    const fiber = (err) => ({ state: 3, name: '@x/p1', _error: err, entry: { options: { id: 'p1', name: '@x/p1' } } });

    // 第 1 次：pending（不是插件自身失败，不应占用 seen）
    ctx.fire('internal/status', fiber('pending (waiting for service: typert)'));
    assert.ok(!readManaged(patch).ids.has('p1'), 'pending 不应禁用');

    // 第 2 次：同一行的真实失败 → 原实现会因 seen 已含 p1 而整条跳过
    ctx.fire('internal/status', fiber('apply failed: real boom'));
    assert.ok(readManaged(patch).ids.has('p1'), '真实失败必须仍被处理并禁用（原实现会被 seen 去重跳过）');
    assert.ok(activeQuarantine(home).some(e => e.rowId === 'p1'), '账本应记录真实失败');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    cleanup();
  }
});
