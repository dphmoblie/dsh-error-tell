// 启动「成功」路径的兜底归因回归（不含 spawn、不含端口）。
//
// 背景：dsh 0.1.7-rc.2 起，插件 import 失败**不再终止进程**，只在 stderr 打
//   `dsh: warning: 1 entry did not activate`
//   `fixture-bad-import (@dsh-error-tell/fixture-bad-import): failed to import`
// 于是「进程活着 / quit 钩子正常退出」不等于「启动健康」。旧代码成功路径完全不看
// stderr，导致探针行被误判为「已验证修好」→ 自动恢复（撤销禁用）；这正是 CI 上
// Phase D3 三条断言失败的原因，也是一个真实的守卫安全性缺陷。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard, splitUnactivated } from '../src/guard.mjs';
import { writeManaged, readManaged } from '../src/patch-writer.mjs';
import { addQuarantine, loadLedger } from '../src/quarantine.mjs';
import { homePatchPath, dshHome } from '../src/home.mjs';

const WARNING = 'dsh: warning: 1 entry did not activate\nfixture-bad-import (@dsh-error-tell/fixture-bad-import): failed to import\n';
const BAD = 'fixture-bad-import';
const BAD_PKG = '@dsh-error-tell/fixture-bad-import';

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'det-survived-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 假 dsh：--version 正常回话；真正的启动回「quit 钩子触发 + 未激活告警」。 */
function fakeDshRun(firstStderr) {
  let runs = 0;
  return async function (bin, args) {
    if (args.includes('--version')) return { code: 0, stdout: '0.1.7-rc.2\n', stderr: '' };
    runs++;
    const stderr = runs === 1 ? firstStderr : '';
    return { code: null, stdout: '', stderr, timedOut: false, quit: true };
  };
}

test('splitUnactivated：区分探针行与普通行，并对已知行去重', () => {
  const rows = [{ id: BAD, name: BAD_PKG }, { id: 'other', name: 'other-pkg' }];
  const probeIds = new Set([BAD]);
  const r1 = splitUnactivated(WARNING, rows, { probeIds });
  assert.deepEqual(r1.ids, [BAD]);
  assert.deepEqual(r1.probe, [BAD], '探针行须被单独标出');
  assert.deepEqual(r1.others, []);
  const r2 = splitUnactivated(WARNING, rows, { probeIds: new Set() });
  assert.deepEqual(r2.probe, []);
  assert.deepEqual(r2.others, [BAD], '非探针行归入 others');
  const r3 = splitUnactivated(WARNING, rows, { probeIds, known: new Set([BAD]) });
  assert.deepEqual(r3.ids, [], 'known 里的行不重复计数');
  assert.deepEqual(splitUnactivated('', rows, { probeIds }).ids, [], '无 stderr 时无归因');
});

test('guard 成功路径：进程存活但探针行未激活 → 不恢复、保持禁用（Phase D3 回归）', async () => {
  const { home, cleanup } = makeHome();
  try {
    const patchPath = homePatchPath(dshHome({ DSH_HOME: home }));
    writeManaged(patchPath, new Set([BAD]));
    // 让该行达到禁用阈值（进入探针集合）
    for (let i = 0; i < 2; i++) addQuarantine(home, { rowId: BAD, package: BAD_PKG, stage: 'import', error: 'boom', source: 'boot-guard' });

    const logs = [];
    const deps = {
      profile: 's2test', env: { ...process.env, DSH_HOME: home },
      dshBin: 'dsh', importChecks: false, restartLimit: 0, quitAfterMs: 90000, timeoutMs: 120000,
      dshInstall: join(home, 'fake-dsh'),
      dshRun: fakeDshRun(WARNING),
      compose: async () => ({ rows: [{ id: BAD, name: BAD_PKG }], issues: [] }),
      log: (m) => logs.push(m)
    };

    const res = await guard(deps);
    assert.equal(res.attempts, 2, '探针失败应剔除探针后再做一次干净启动（attempts=2）');
    assert.equal(res.probeIds.includes(BAD), true);
    const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
    assert.match(patch, /- id: fixture-bad-import/, '坏行必须仍留在 managed 段');
    assert.match(patch, /disabled: true/, '坏行必须仍为 disabled: true');
    const ledger = loadLedger(home);
    const entry = ledger.entries.find(e => e.rowId === BAD);
    assert.ok(entry, '账本须仍有该行');
    assert.equal(entry.restoredAt, undefined, '不得被误标为已恢复');
    assert.ok(logs.some(l => l.includes('探针行仍未激活，保持禁用')), '须明确记录保持禁用的原因');
  } finally { cleanup(); }
});

test('guard 成功路径：普通行未激活 → 记入账本（source=boot-guard-survived-boot），未达阈值不禁用', async () => {
  const { home, cleanup } = makeHome();
  try {
    const panel = { id: 'bad-plugin', name: 'bad-plugin' };
    const stderr = 'dsh: warning: 1 entry did not activate\nbad-plugin (bad-plugin): failed to import\n';
    const deps = {
      profile: 's2test', env: { ...process.env, DSH_HOME: home },
      dshBin: 'dsh', importChecks: false, restartLimit: 0, quitAfterMs: 90000, timeoutMs: 120000,
      dshInstall: join(home, 'fake-dsh'),
      dshRun: fakeDshRun(stderr),
      compose: async () => ({ rows: [panel], issues: [] }),
      log: () => {}
    };
    const res = await guard(deps);
    const entry = loadLedger(home).entries.find(e => e.rowId === 'bad-plugin');
    assert.ok(entry, '存活的坏行也必须记账（旧代码完全不记）');
    assert.equal(entry.source, 'boot-guard-survived-boot');
    assert.equal(res.disabled.includes('bad-plugin'), false, '第一次失败只观察，不禁用');
    assert.equal(readManaged(homePatchPath(dshHome({ DSH_HOME: home }))).ids.size, 0, '未达阈值不得写 managed');
  } finally { cleanup(); }
});
