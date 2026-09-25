// Phase H 的兜底路径：guard 的「进程级超时」（compose.mjs runDsh 的 timeoutMs 分支）。
//
// 以前这条分支只有真机 e2e（Phase H）覆盖，而 dsh 的启动行为随版本变：
// 0.1.7-rc.2 起 import/apply 失败都只打 warning、进程继续活着，只有「挂起」才靠超时兜底；
// 一旦 dsh 在新版本上自己退出（非 0 码），Phase H 的 timedOut 断言就不再成立。
// 所以把该分支直接用「永不退出的 node 进程」固定在单测里：不依赖 dsh 版本、不开监听端口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDsh } from '../src/compose.mjs';

const HANG = ['-e', 'setTimeout(() => {}, 60000)'];

test('runDsh：到点杀掉挂起的子进程并返回 timedOut（Phase H 兜底回归）', async () => {
  const t0 = Date.now();
  const res = await runDsh(process.execPath, HANG, { env: process.env, timeoutMs: 800 });
  const ms = Date.now() - t0;
  assert.equal(res.timedOut, true, '必须标记 timedOut：CLI 据此判 ok=false 并退出码 5');
  assert.equal(res.code, null, '被超时杀掉的子进程没有正常退出码');
  assert.equal(res.quit, false, '超时不是测试 quit 钩子，不能当成正常结束');
  assert.ok(ms < 15000, '应到点即返回（实测 ' + ms + 'ms），而不是等子进程自己结束');
});

test('runDsh：quit 钩子到点返回 quit=true（测试专用「正常结束」）', async () => {
  const res = await runDsh(process.execPath, HANG, { env: process.env, timeoutMs: 0, quitAfterMs: 500 });
  assert.equal(res.quit, true, 'quit 钩子必须标记 quit=true');
  assert.equal(res.timedOut, false, 'quit 钩子不算超时');
  assert.equal(res.code, null, 'quit 钩子是杀掉进程，没有正常退出码');
});
