// runChecks 重构的回归测试：结果顺序、唯一包去重、并发限流、跳过规则。
// 用可注入 runner 替代真实子进程干跑，因此不需要 spawn（沙箱/CI 友好）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, clearImportCache } from '../src/checks.mjs';

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
