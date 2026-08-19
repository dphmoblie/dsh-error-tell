// Phase D：宿主 import 失败（bad-import）——dry-run 预检命中；
// 真实流程：第 1 次失败（无 quit，等真实退出）→ 第 2 次失败禁用 → 禁用后启动成功（quit 90s 大窗口，适配慢机器）
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmpBase = (await import('node:os')).tmpdir();
const HOME = join(tmpBase, 'dsh-error-tell-d-home');
let failed = 0;
function ok(c, m) { if (!c) { failed++; console.error('✖ FAIL:', m); } else console.log('✔', m); }
function parseJ(out) {
  const candidates = [...out.matchAll(/\{[\s\S]*?\n\}/g)].map(m => m[0]);
  for (const c of [...candidates].reverse()) {
    try { const o = JSON.parse(c); if (o && 'ok' in o) return o; } catch { /* 跳过 */ }
  }
  return null;
}
// 预期失败的调用：exit 5 会被 execSync 抛出，捕获并返回 stdout
function runGuard(extraEnv) {
  try {
    return execSync('node "' + BIN + '" guard --profile s2test --restart-limit 0 --timeout-ms 90000 --no-import-checks', { cwd: ROOT, encoding: 'utf8', timeout: 150000, env: { ...env, ...(extraEnv || {}) } });
  } catch (e) { return e.stdout || ''; }
}

rmSync(HOME, { recursive: true, force: true });
const profileDir = join(HOME, 'profiles', 's2test');
mkdirSync(profileDir, { recursive: true });
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-s2test', private: true,
  dependencies: { '@dsh-error-tell/fixture-bad-import': 'file:' + join(ROOT, 'packages', 'test-fixtures', 'bad-import').replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
}, null, 2) + '\n');
writeFileSync(join(profileDir, 'cordis.patch.yml'), ['- insert:', '    - id: fixture-bad-import', "      name: '@dsh-error-tell/fixture-bad-import'"].join('\n') + '\n');
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
execSync('pnpm install --offline', { cwd: profileDir, encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
ok(existsSync(join(profileDir, 'node_modules', '@dsh-error-tell', 'fixture-bad-import', 'index.mjs')), 'install 后 fixture 链接存在');
const env = { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1' };

// dry-run：预检命中 + 零写入
const dry = execSync('node "' + BIN + '" guard --profile s2test --dry-run', { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
ok(dry.includes('[error/import] fixture-bad-import'), '[D] dry-run 预检命中 import 失败行');
ok(!existsSync(join(HOME, 'cordis.patch.yml')), '[D] dry-run 未写 patch');
ok(!existsSync(join(HOME, 'state', 'dsh-error-tell', 'quarantine.json')), '[D] dry-run 未写账本（零副作用）');

// 第 1 次真实启动：预期失败（无 quit，等真实退出）
const out1 = runGuard();
const j1 = parseJ(out1);
const ledger1 = JSON.parse(readFileSync(join(HOME, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
const e1 = ledger1.entries.find(x => x.rowId === 'fixture-bad-import' && !x.restoredAt);
ok(j1 && j1.ok === false, '[D1] 第 1 次启动失败（ok=' + (j1 && j1.ok) + '）');
ok(e1 && e1.failCount === 1, '[D1] failCount=1（观察中）');
ok(!existsSync(join(HOME, 'cordis.patch.yml')), '[D1] 未写禁用');

// 第 2 次真实启动：预期失败 → 禁用
const out2 = runGuard();
const j2 = parseJ(out2);
const ledger2 = JSON.parse(readFileSync(join(HOME, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
const e2 = ledger2.entries.find(x => x.rowId === 'fixture-bad-import' && !x.restoredAt);
const patch2 = readFileSync(join(HOME, 'cordis.patch.yml'), 'utf8');
ok(j2 && j2.ok === false, '[D2] 第 2 次启动失败（ok=' + (j2 && j2.ok) + '）');
ok(e2 && e2.failCount === 2, '[D2] failCount=2');
ok(patch2.includes('- id: fixture-bad-import') && patch2.includes('disabled: true'), '[D2] 已写 managed 禁用');

// 第 3 次启动（已禁用）：预期成功（quit 90s 大窗口，慢机器友好）
let out3 = '';
try {
  out3 = execSync('node "' + BIN + '" guard --profile s2test --restart-limit 0 --timeout-ms 120000 --no-import-checks', { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...env, DSH_ERROR_TELL_QUIT_AFTER_MS: '90000' } });
} catch (e) { out3 = e.stdout || ''; }
const j3 = parseJ(out3);
ok(j3 && j3.ok === true && j3.attempts === 1, '[D3] 禁用后启动成功（ok=' + (j3 && j3.ok) + '）');
console.log('=== Phase D 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
