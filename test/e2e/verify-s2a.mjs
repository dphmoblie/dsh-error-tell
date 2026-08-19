// S2 场景 A：连续 2 次失败才禁用（两次独立 guard 调用，restart-limit 0，无 quit 竞态）
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmpBase = (await import('node:os')).tmpdir();
const HOME = join(tmpBase, 'dsh-error-tell-s2-home');
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
  dependencies: { '@dsh-error-tell/fixture-bad-apply': 'file:' + join(ROOT, 'packages', 'test-fixtures', 'bad-apply').replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
}, null, 2) + '\n');
writeFileSync(join(profileDir, 'cordis.patch.yml'), ['- insert:', '    - id: fixture-bad-apply', "      name: '@dsh-error-tell/fixture-bad-apply'"].join('\n') + '\n');
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
execSync('pnpm install --offline', { cwd: profileDir, encoding: 'utf8', timeout: 90000, stdio: 'pipe' });
ok(existsSync(join(profileDir, 'node_modules', '@dsh-error-tell', 'fixture-bad-apply', 'index.mjs')), 'install 后 fixture 链接存在');
writeFileSync(join(ROOT, '.tmp', 's2-home-path.txt'), HOME, 'utf8');
const baseEnv = { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1' };
function runGuard() {
  try {
    return execSync('node "' + BIN + '" guard --profile s2test --restart-limit 0 --timeout-ms 45000 --no-import-checks', {
      cwd: ROOT, encoding: 'utf8', timeout: 110000, env: baseEnv
    });
  } catch (e) {
    return e.stdout || ''; // guard 预期失败退出 5：捕获输出
  }
}


// 第 1 次调用：预期失败但不禁用（观察中）
const out1 = runGuard();
const j1 = parseJ(out1);
let ledger1 = JSON.parse(readFileSync(join(HOME, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
const e1 = ledger1.entries.find(x => x.rowId === 'fixture-bad-apply' && !x.restoredAt);
ok(j1 && j1.ok === false, '[A1] 第 1 次启动失败（ok=' + (j1 && j1.ok) + '）');
ok(e1 && e1.failCount === 1, '[A1] 账本 failCount=1');
ok(!existsSync(join(HOME, 'cordis.patch.yml')), '[A1] 未写 managed 禁用（观察中）');

// 第 2 次调用：再次失败 → 达到阈值 → 禁用
const out2 = runGuard();
const j2 = parseJ(out2);
const ledger2 = JSON.parse(readFileSync(join(HOME, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
const e2 = ledger2.entries.find(x => x.rowId === 'fixture-bad-apply' && !x.restoredAt);
const patch2 = readFileSync(join(HOME, 'cordis.patch.yml'), 'utf8');
ok(j2 && j2.ok === false, '[A2] 第 2 次启动失败（ok=' + (j2 && j2.ok) + '）');
ok(e2 && e2.failCount === 2, '[A2] 账本 failCount=2');
ok(patch2.includes('- id: fixture-bad-apply') && patch2.includes('disabled: true'), '[A2] 第 2 次失败后写入 managed 禁用');
ok(j2.disabled.includes('fixture-bad-apply'), '[A2] 禁用列表含坏行');
console.log('=== 场景 A 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
