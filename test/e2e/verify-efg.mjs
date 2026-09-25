// 阶段验证 2：Phase E（幂等性）+ F（YAML 损坏）+ G（多坏插件）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkProfile } from './link-profile.mjs';
// P1：统一辅助模块——参数转义/超时杀进程树/POSIX 进程组都只有一份实现
import { run } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmp = mkdtempSync(join((await import('node:os')).tmpdir(), 'det-efg-'));
let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('✖ FAIL:', msg); } else console.log('✔', msg); }
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
linkProfile(join(homeE, 'profiles', 'web'), {}); // 无 file: 依赖也要链接（DET_DSH_PREFIX 时含官方包 junction）
ok(true, '[E] 无依赖沙箱（已链接官方包）');
// 上限 120 s：CI 实测该步骤约 25~30 s，其中「逐行 import 干跑」占大头（93 行、并发 4），
// 预检超时还会重试一次（+最多 20 s），故留足余量避免把慢误判成挂死。
const gE = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envE, DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' }, timeoutMs: 120000 });
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
linkProfile(join(homeG, 'profiles', 'web'), {
  '@dsh-error-tell/fixture-bad-import': 'packages/test-fixtures/bad-import',
  '@dsh-error-tell/fixture-bad-apply': 'packages/test-fixtures/bad-apply'
});
ok(true, '[G] 沙箱依赖已链接（junction）');
// 上限 300 s：CI 实测「2 次启动」段为 87 s（13:54:57→13:56:25），修好「归因禁用后必须重启交付」后
// 变成 3 次启动（每次都要跑满 quit 窗口 60 s）⇒ 线性外推 ≈ 130 s+，旧的 120 s 上限会在第 3 次启动中途
// 把 guard 杀掉（kill 后没有最终 JSON，断言会得到 attempts=undefined 的假失败）。
const gG = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '2'], { env: { ...envG, DSH_ERROR_TELL_QUIT_AFTER_MS: '60000' }, timeoutMs: 300000 });
const jG = JSON.parse((gG.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
// S2 语义：import 坏行预检命中，apply 坏行第 1 次启动才暴露（观察中），第 2 次重启后禁用，第 3 次启动成功
ok(jG.ok === true && jG.attempts >= 3, '[G] 多坏插件最终正常启动（attempts=' + jG.attempts + '）');
ok(jG.disabled.includes('fixture-bad-import') && jG.disabled.includes('fixture-bad-apply'), '[G] 两个坏行都在禁用列表');
const ledgerG = JSON.parse(readFileSync(join(homeG, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
ok(ledgerG.entries.filter(e2 => !e2.restoredAt).length === 2, '[G] 账本含 2 条活动中记录');

rmSync(tmp, { recursive: true, force: true });
console.log('=== Phase E+F+G 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
