// S2 验证：场景 A（连续 2 次失败才禁用）+ 场景 B（探针成功自动恢复）
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const FIXTURE = join(ROOT, 'packages', 'test-fixtures', 'bad-apply');
const tmp = mkdtempSync(join(process.env.TEMP || 'C:\\Users\\user\\AppData\\Local\\Temp', 's2-'));
const home = join(tmp, 'home');
const profileDir = join(home, 'profiles', 'web');
mkdirSync(profileDir, { recursive: true });
let failed = 0;
function ok(c, m) { if (!c) { failed++; console.error('✖ FAIL:', m); } else console.log('✔', m); }
function runGuard(extraEnv) {
  return execSync('node "' + BIN + '" guard --profile web --port 0 --restart-limit 2 --timeout-ms 45000', {
    cwd: ROOT, encoding: 'utf8', timeout: 150000,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...(extraEnv || {}) }
  });
}

function mkProfile() {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { '@dsh-error-tell/fixture-bad-apply': 'file:' + FIXTURE.replaceAll('\\', '/') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
  }, null, 2) + '\n');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), ['- insert:', '    - id: fixture-bad-apply', "      name: '@dsh-error-tell/fixture-bad-apply'"].join('\n') + '\n');
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  execSync('pnpm install --offline', { cwd: profileDir, encoding: 'utf8', timeout: 90000, stdio: 'pipe' });
}
function readLedger() {
  try { return JSON.parse(readFileSync(join(home, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8')); } catch { return { entries: [] }; }
}
function patchText() { try { return readFileSync(join(home, 'cordis.patch.yml'), 'utf8'); } catch { return ''; } }

// ===== 场景 A：坏插件，连续 2 次失败才禁用 ===== 
mkProfile();
const outA = runGuard({ DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' });
const jA = JSON.parse((outA.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jA.ok === true, '[A] 最终正常启动（ok=' + jA.ok + '）');
ok(jA.attempts === 3, '[A] 三次尝试（失败1→观察、失败2→禁用、成功）（attempts=' + jA.attempts + '）');
ok(jA.disabled.includes('fixture-bad-apply'), '[A] 禁用列表含坏行');
ok(patchText().includes('- id: fixture-bad-apply') && patchText().includes('disabled: true'), '[A] managed 段已写禁用');
const eA = readLedger().entries.find(x => x.rowId === 'fixture-bad-apply' && !x.restoredAt);
ok(eA && eA.failCount === 2, '[A] 账本 failCount=2（source=' + (eA && eA.source) + '）');

// ===== 场景 B：修复插件后，探针成功自动恢复 ===== 
// 把 fixture 的 apply 改成正常（模拟用户修复）
writeFileSync(join(FIXTURE, 'index.mjs'), [
  "export const name = 'fixture-bad-apply';",
  'export function apply() { /* 已修复 */ }',
  ''
].join('\n'));
const outB = runGuard({ DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' });
const jB = JSON.parse((outB.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jB.ok === true && jB.attempts === 1, '[B] 探针启动一次成功（attempts=' + jB.attempts + '）');
ok(!patchText().includes('- id: fixture-bad-apply'), '[B] managed 段已移除该行（自动恢复）');
const eB = readLedger().entries.find(x => x.rowId === 'fixture-bad-apply');
ok(eB && eB.restoredAt, '[B] 账本已标记恢复（restoredAt=' + (eB && eB.restoredAt) + '）');
// 还原 fixture
writeFileSync(join(FIXTURE, 'index.mjs'), [
  "export const name = 'fixture-bad-apply';",
  'export function apply() {',
  "  throw new Error('[dsh-error-tell] fixture: apply 阶段抛错（用于测试）');",
  '}',
  ''
].join('\n'));

rmSync(tmp, { recursive: true, force: true });
console.log('=== S2 验证完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
