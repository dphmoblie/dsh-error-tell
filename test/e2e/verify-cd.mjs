// 阶段验证 1：Phase C（client-tell）+ Phase D（import 预检拦截）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkProfile } from './link-profile.mjs';
// P1：统一辅助模块——参数转义/超时杀进程树/POSIX 进程组都只有一份实现
import { dumpServer, originOf, parseWebUrl, run, startServer } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
// M5：原为 process.env.TEMP || 'C:\\Users\\user\\AppData\\Local\\Temp'（硬编码 Windows 路径，非 Windows 直接失败）
const tmp = mkdtempSync(join(tmpdir(), 'det-cd-'));
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

// ===== Phase C ===== 
const homeC = join(tmp, 'homeC');
const profileC = mkProfile(homeC, {
  '@dsh-error-tell/client-tell': fileDep('packages/client-tell'),
  '@dsh-error-tell/fixture-bad-client': fileDep('packages/test-fixtures/bad-client')
}, ['- insert:', '    - id: fixture-bad-client', "      name: '@dsh-error-tell/fixture-bad-client'"]);
// 加 client-tell bundle
const pkgC = JSON.parse(readFileSync(join(profileC, 'package.json'), 'utf8'));
pkgC.dsh.profile.bundles.push('@dsh-error-tell/client-tell');
writeFileSync(join(profileC, 'package.json'), JSON.stringify(pkgC, null, 2) + '\n');
linkProfile(profileC, {
  '@dsh-error-tell/client-tell': 'packages/client-tell',
  '@dsh-error-tell/core': 'packages/core',
  '@dsh-error-tell/fixture-bad-client': 'packages/test-fixtures/bad-client'
});
ok(true, '[C] 沙箱依赖已链接（junction）');
const envC = { ...process.env, DSH_HOME: homeC, DSH_TELEMETRY_DISABLED: '1' };
// M5：不预先探测端口。原「探针拿端口 → 关闭 → 让 dsh 绑同一端口」有 TOCTOU 竞态；
// dsh 打印的 `dsh web: <url>?token=` 里就是实际绑定端口，故用 --port 0 + 从 stdout 取端口。
const server = startServer('dsh', ['--profile', 'web', '--port', '0'], { env: { ...envC, DSH_ERROR_TELL_TOKEN: 'test-token' } });
let ready = false;
const origin = () => originOf(parseWebUrl(server.stdout()));
for (let i = 0; i < 90; i++) {
  try { const r = await fetch(origin() + '/'); if (r.status === 200) { ready = true; break; } } catch {}
  if (!server.alive()) break;
  await new Promise(r2 => setTimeout(r2, 1000));
}
if (!(ready && server.alive())) dumpServer(server, 'dsh（Phase CD）');
ok(ready && server.alive(), '[C] web 服务就绪且宿主存活');
let html1 = '';
try { html1 = await (await fetch(origin() + '/')).text(); } catch {}
ok(html1.includes('// dsh-error-tell 注入脚本'), '[C] 注入脚本存在');
ok(html1.includes('fixture-bad-client'), '[C] __DSH_BOOT__ 含坏 client 行');
const dis = await fetch(origin() + '/api/error-tell/disable', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' },
  body: JSON.stringify({ rowId: '@dsh-error-tell/fixture-bad-client' })
}).then(r => r.json()).catch(e => ({ error: e.message }));
ok(dis.ok === true, '[C] 禁用端点 ok');
let html2 = '';
for (let i = 0; i < 10; i++) {
  await new Promise(r2 => setTimeout(r2, 1000));
  try { html2 = await (await fetch(origin() + '/')).text(); } catch {}
  if (!html2.includes('fixture-bad-client')) break;
}
ok(!html2.includes('fixture-bad-client'), '[C] 禁用后组合图排除坏行');
const patchC = readFileSync(join(homeC, 'cordis.patch.yml'), 'utf8');
ok(patchC.includes('- id: fixture-bad-client') && patchC.includes('disabled: true'), '[C] home patch 已禁用');
server.stop();

// ===== Phase D ===== 
const homeD = join(tmp, 'homeD');
mkProfile(homeD, { '@dsh-error-tell/fixture-bad-import': fileDep('packages/test-fixtures/bad-import') }, ['- insert:', '    - id: fixture-bad-import', "      name: '@dsh-error-tell/fixture-bad-import'"]);
const envD = { ...process.env, DSH_HOME: homeD, DSH_TELEMETRY_DISABLED: '1' };
linkProfile(join(homeD, 'profiles', 'web'), { '@dsh-error-tell/fixture-bad-import': 'packages/test-fixtures/bad-import' });
ok(true, '[D] 沙箱依赖已链接（junction）');
const dryD = await run('node', [BIN, 'guard', '--profile', 'web', '--dry-run'], { env: envD, timeoutMs: 45000 });
ok(dryD.stdout.includes('[error/import] fixture-bad-import'), '[D] dry-run 预检发现 import 失败行');
const gD = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envD, DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' }, timeoutMs: 60000 });
const jD = JSON.parse((gD.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jD.ok === true && jD.attempts === 2 && jD.disabled.includes('fixture-bad-import'), '[D] S2 语义：预检首次观察 → 二次失败禁用 → 重启成功 attempts=' + jD.attempts + ' disabled=' + JSON.stringify(jD.disabled));

rmSync(tmp, { recursive: true, force: true });
console.log('=== Phase C+D 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
