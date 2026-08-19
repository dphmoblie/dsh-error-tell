// 阶段验证 2：Phase E（幂等性）+ F（YAML 损坏）+ G（多坏插件）
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmp = mkdtempSync(join(process.env.TEMP || 'C:\\Users\\user\\AppData\\Local\\Temp', 'det-efg-'));
let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('✖ FAIL:', msg); } else console.log('✔', msg); }
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true, shell: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, stdout: out, stderr: err, timedOut: true }); }, opts.timeoutMs || 60000);
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => err += d);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout: out, stderr: err, error: e.message }); });
  });
}
function mkProfile(home, deps, rows) {
  const profileDir = join(home, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: deps, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2) + '\n');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), rows.join('\n') + '\n');
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  return profileDir;
}
const fileDep = (p) => 'file:' + join(ROOT, p).replaceAll('\\', '/');

// ===== Phase E：幂等性（干净 profile 零副作用）=====
const homeE = join(tmp, 'homeE');
const profileE = join(homeE, 'profiles', 'web');
  mkdirSync(profileE, { recursive: true });
  writeFileSync(join(profileE, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2) + '\n');
  writeFileSync(join(profileE, 'cordis.yml'), '[]\n'); // 无 profile patch（干净）
const envE = { ...process.env, DSH_HOME: homeE, DSH_TELEMETRY_DISABLED: '1' };
const instE = await run('pnpm', ['install', '--offline'], { cwd: join(homeE, 'profiles', 'web'), timeoutMs: 60000 });
ok(instE.code === 0, '[E] pnpm install exit=' + instE.code);
const gE = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envE, DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' }, timeoutMs: 60000 });
const jE = JSON.parse((gE.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jE.ok === true && jE.attempts === 1 && jE.disabled.length === 0, '[E] 干净 profile 一次启动成功，未禁用任何行（attempts=' + jE.attempts + '）');
ok(!existsSync(join(homeE, 'cordis.patch.yml')), '[E] 未创建 home patch（零副作用）');
ok(!existsSync(join(homeE, 'state', 'dsh-error-tell')), '[E] 未创建隔离账本（零副作用）');

// ===== Phase F：YAML 损坏 → 友好失败 ===== 
const homeF = join(tmp, 'homeF');
mkdirSync(join(homeF, 'profiles'), { recursive: true });
writeFileSync(join(homeF, 'cordis.patch.yml'), '::::broken::::\n');
const envF = { ...process.env, DSH_HOME: homeF, DSH_TELEMETRY_DISABLED: '1' };
const gF = await run('node', [BIN, 'guard', '--profile', 'web'], { env: envF, timeoutMs: 45000 });
ok(gF.code === 6, '[F] YAML 损坏退出码 6（' + gF.code + '）');
ok((gF.stderr + gF.stdout).includes('guard 失败'), '[F] 友好错误信息');
ok(!existsSync(join(homeF, 'state', 'dsh-error-tell', 'quarantine.json')), '[F] 未写账本');

// ===== Phase G：多坏插件（import + apply）=====
const homeG = join(tmp, 'homeG');
mkProfile(homeG, {
  '@dsh-error-tell/fixture-bad-import': fileDep('packages/test-fixtures/bad-import'),
  '@dsh-error-tell/fixture-bad-apply': fileDep('packages/test-fixtures/bad-apply')
}, ['- insert:', '    - id: fixture-bad-import', "      name: '@dsh-error-tell/fixture-bad-import'", '    - id: fixture-bad-apply', "      name: '@dsh-error-tell/fixture-bad-apply'"]);
const envG = { ...process.env, DSH_HOME: homeG, DSH_TELEMETRY_DISABLED: '1' };
const instG = await run('pnpm', ['install', '--offline'], { cwd: join(homeG, 'profiles', 'web'), timeoutMs: 60000 });
ok(instG.code === 0, '[G] pnpm install exit=' + instG.code);
const gG = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envG, DSH_ERROR_TELL_QUIT_AFTER_MS: '25000' }, timeoutMs: 80000 });
const jG = JSON.parse((gG.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jG.ok === true && jG.attempts >= 2, '[G] 多坏插件最终正常启动（attempts=' + jG.attempts + '）');
ok(jG.disabled.includes('fixture-bad-import') && jG.disabled.includes('fixture-bad-apply'), '[G] 两个坏行都在禁用列表');
const ledgerG = JSON.parse(readFileSync(join(homeG, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
ok(ledgerG.entries.filter(e2 => !e2.restoredAt).length === 2, '[G] 账本含 2 条活动中记录');

rmSync(tmp, { recursive: true, force: true });
console.log('=== Phase E+F+G 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
