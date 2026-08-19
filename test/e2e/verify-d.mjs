// Phase D：宿主 import 失败（bad-import）——dry-run 预检命中 + S2 语义下第 2 次失败禁用
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmpBase = process.env.TEMP || 'C:\\Users\\user\\AppData\\Local\\Temp';
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
execSync('pnpm install --offline', { cwd: profileDir, encoding: 'utf8', timeout: 90000, stdio: 'pipe' });
ok(existsSync(join(profileDir, 'node_modules', '@dsh-error-tell', 'fixture-bad-import', 'index.mjs')), 'install 后 fixture 链接存在');
const env = { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1' };

// dry-run：预检应命中 import 失败行（不写任何配置）
const dry = execSync('node "' + BIN + '" guard --profile s2test --dry-run', { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
ok(dry.includes('[error/import] fixture-bad-import'), '[D] dry-run 预检命中 import 失败行');
ok(!existsSync(join(HOME, 'cordis.patch.yml')), '[D] dry-run 零写入');

// 真实 guard：第 1 次失败观察 → 第 2 次失败禁用 → 第 3 次成功（S2 语义）
let out = '';
try {
  out = execSync('node "' + BIN + '" guard --profile s2test --restart-limit 2 --timeout-ms 45000 --no-import-checks', { cwd: ROOT, encoding: 'utf8', timeout: 110000, env: { ...env, DSH_ERROR_TELL_QUIT_AFTER_MS: '20000' } });
} catch (e) { out = e.stdout || ''; }
console.log(out.slice(-1400));
const j = parseJ(out);
const patchText = readFileSync(join(HOME, 'cordis.patch.yml'), 'utf8');
const ledger = JSON.parse(readFileSync(join(HOME, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
const e = ledger.entries.find(x => x.rowId === 'fixture-bad-import' && !x.restoredAt);
ok(j && j.ok === true && j.attempts === 3, '[D] 最终正常启动（attempts=' + (j && j.attempts) + '，1观察/2禁用/3成功）');
ok(patchText.includes('- id: fixture-bad-import') && patchText.includes('disabled: true'), '[D] managed 段已写禁用');
ok(e && e.failCount === 2, '[D] 账本 failCount=2');
console.log('=== Phase D 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
