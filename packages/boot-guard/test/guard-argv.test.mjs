// buildDshArgs 的回归测试（不需要 spawn、不需要端口）。
//
// 背景（Phase D3 在 CI 上失败的根因）：dsh launcher 只解析自己的 flag，遇到第一个
// 自家以外的 flag 就把后面所有参数原样交给 app。`--no-open` 是 web app 的 flag，
// 而旧实现把它排在 `--patch` 之前 —— 于是 launcher 段被截断，用户 `--patch` 与
// 探针覆盖层都没被收集：dsh 实际仍按 home 层的 `disabled: true` 启动，「探针成功」
// 是假的，守卫会把这个从未真正验证过的坏行自动恢复（撤销禁用）。
// 实测：`dsh --profile s2test --dump-config --no-open --patch p.yml`
//   → error: config dumps take no app arguments, got "--no-open" "--patch" "…p.yml"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDshArgs } from '../src/guard.mjs';

/** dsh launcher 自家认识的 flag（`dsh/lib/bin.js` 的 commander 声明）。 */
const LAUNCHER_FLAGS = new Set(['--profile', '--patch', '--dump-config', '--dump-default-config', '--dump-config-schema']);

/**
 * 复刻 dsh launcher 的解析规则：从前往后只吃自家 flag，遇到第一个自家以外的
 * flag 就停止，其余原样交给 app。
 * @param argv - 完整参数列表。
 * @returns 收集到的 profile / patches，以及被当作 app 参数的后半段。
 */
function launcherParse(argv) {
  const out = { profile: null, patches: [], appArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!LAUNCHER_FLAGS.has(flag)) {
      out.appArgs = argv.slice(i);
      return out;
    }
    if (flag === '--patch') out.patches.push(argv[++i]);
    else if (flag === '--profile') out.profile = argv[++i];
  }
  return out;
}

test('buildDshArgs：探针覆盖层必须排在 --no-open 之前（Phase D3 回归）', () => {
  const args = buildDshArgs({ profile: 's2test', probePatchFile: 'C:\\tmp\\probe.yml', quitAfterMs: 90000 });
  const parsed = launcherParse(args);
  assert.equal(parsed.profile, 's2test');
  assert.deepEqual(parsed.patches, ['C:\\tmp\\probe.yml'], 'launcher 必须收集到探针覆盖层，否则探针是空转的');
  assert.equal(parsed.appArgs[0], '--no-open', '--no-open 应落在 app 段');
});

test('buildDshArgs：同一个顺序也保证用户 --patch 不被丢掉', () => {
  const args = buildDshArgs({ profile: 'web', patchFiles: ['u1.yml', 'u2.yml'], probePatchFile: 'p.yml', quitAfterMs: 1 });
  const parsed = launcherParse(args);
  assert.deepEqual(parsed.patches, ['u1.yml', 'u2.yml', 'p.yml'], '用户层在前、探针层在最后（优先级最高）');
  assert.deepEqual(parsed.appArgs, ['--no-open']);
});

test('旧顺序确实是坏的：app flag 之后 launcher 不再收集 --patch', () => {
  const oldOrder = ['--profile', 's2test', '--no-open', '--patch', 'probe.yml'];
  assert.deepEqual(launcherParse(oldOrder).patches, [], '旧顺序会静默丢掉 --patch —— 这就是 D3 的失败机制');
});

test('buildDshArgs：--patch 的顺序不变量（launcher 段不得出现在 app flag 之后）', () => {
  const args = buildDshArgs({ profile: 'p', patchFiles: ['a.yml'], probePatchFile: 'b.yml', port: 0, quitAfterMs: 5000, extraArgs: ['--foo'] });
  const firstApp = args.findIndex(a => a === '--no-open' || a === '--port');
  assert.ok(firstApp > 0, '应存在 app 段');
  const patchIdx = args.map((a, i) => a === '--patch' ? i : -1).filter(i => i >= 0);
  assert.equal(patchIdx.length, 2);
  for (const i of patchIdx) assert.ok(i < firstApp, '--patch 必须全部在第一个 app flag 之前');
  assert.deepEqual(args.slice(-1), ['--foo'], 'extraArgs 在最后');
});

test('buildDshArgs：--no-open 只在 quit 钩子模式出现', () => {
  assert.equal(buildDshArgs({ profile: 'p', quitAfterMs: 0 }).includes('--no-open'), false);
  assert.equal(buildDshArgs({ profile: 'p', quitAfterMs: 90000 }).includes('--no-open'), true);
});

test('buildDshArgs：port 未传/空值不传 --port，显式 0 才传（P1-1）', () => {
  for (const port of [undefined, null, '']) {
    assert.equal(buildDshArgs({ profile: 'p', port }).includes('--port'), false, 'port=' + String(port) + ' 不应传 --port');
  }
  assert.deepEqual(buildDshArgs({ profile: 'p', port: 0 }).slice(-2), ['--port', '0']);
  assert.deepEqual(buildDshArgs({ profile: 'p', port: 61156 }).slice(-2), ['--port', '61156']);
});

test('buildDshArgs：无探针时不产生 --patch，只保留 profile', () => {
  const args = buildDshArgs({ profile: 'web' });
  assert.deepEqual(args, ['--profile', 'web']);
  assert.deepEqual(launcherParse(args).patches, []);
});
