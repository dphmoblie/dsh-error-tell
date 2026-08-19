// S2 场景 B：修复插件后，guard 探针成功 → 自动恢复（managed 移除 + 账本 restoredAt）
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const FIXTURE = join(ROOT, 'packages', 'test-fixtures', 'bad-apply', 'index.mjs');
const HOME = readFileSync(join(ROOT, '.tmp', 's2-home-path.txt'), 'utf8').trim();
let failed = 0;
function ok(c, m) { if (!c) { failed++; console.error('✖ FAIL:', m); } else console.log('✔', m); }

// 前置条件：场景 A 的禁用状态必须存在
const prePatch = readFileSync(join(HOME, 'cordis.patch.yml'), 'utf8');
ok(prePatch.includes('- id: fixture-bad-apply'), '[B] 前置：行已处于禁用状态');

// 备份并改成正常插件（模拟用户修复）
const backup = readFileSync(FIXTURE, 'utf8');
try {
  writeFileSync(FIXTURE, [
    "export const name = 'fixture-bad-apply';",
    'export function apply() { /* 已修复 */ }',
    ''
  ].join('\n'));
  const out = execSync('node "' + BIN + '" guard --profile s2test --restart-limit 1 --timeout-ms 45000 --no-import-checks', {
    cwd: ROOT, encoding: 'utf8', timeout: 110000,
    env: { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1', DSH_ERROR_TELL_QUIT_AFTER_MS: '20000' }
  });
  console.log(out.slice(-1400));
  let j = null;
  const candidates = [...out.matchAll(/\{[\s\S]*?\n\}/g)].map(m => m[0]);
  for (const c of [...candidates].reverse()) {
    try { const o = JSON.parse(c); if (o && 'ok' in o) { j = o; break; } } catch { /* 跳过 */ }
  }
  if (!j) { console.error('未找到 guard 结果 JSON'); process.exit(1); }
  // S1 修复：恢复后若文件只剩 managed 段则整文件被删除，两种形态都算正确
  const patchPath = join(HOME, 'cordis.patch.yml');
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const ledger = JSON.parse(readFileSync(join(HOME, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
  const e = ledger.entries.find(x => x.rowId === 'fixture-bad-apply');
  ok(j.ok === true, '[B] 探针启动成功（ok=' + j.ok + '）');
  ok(!patchText.includes('- id: fixture-bad-apply'), '[B] managed 段已移除该行（自动恢复）');
  ok(e && e.restoredAt, '[B] 账本已标记恢复（restoredAt=' + (e && e.restoredAt ? 'set' : 'none') + '）');
} finally {
  // 无论成败都还原 fixture
  writeFileSync(FIXTURE, backup, 'utf8');
}
console.log('=== 场景 B 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
