// 阶段验证 1：Phase C（client-tell）+ Phase D（import 预检拦截）
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmp = mkdtempSync(join(process.env.TEMP || 'C:\\Users\\user\\AppData\\Local\\Temp', 'det-cd-'));
let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('✖ FAIL:', msg); } else console.log('✔', msg); }
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    // L9：args + shell:true 会触发 Node DEP0190；拼接为命令串（参数加引号）
    const cmdline = [cmd, ...args.map(a => '"' + String(a).replace(/"/g, '\\"') + '"')].join(' ');
    const child = spawn(cmdline, { ...opts, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true, shell: true });
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
const instC = await run('pnpm', ['install', '--offline'], { cwd: profileC, timeoutMs: 60000 });
ok(instC.code === 0, '[C] pnpm install exit=' + instC.code);
const envC = { ...process.env, DSH_HOME: homeC, DSH_TELEMETRY_DISABLED: '1' };
// M5：随机空闲端口（避免固定端口冲突）
import { createServer as createProbeServer } from 'node:net';
const PORT = await new Promise((res) => { const s = createProbeServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn('dsh', ['--profile', 'web', '--port', String(PORT)], { env: { ...envC, DSH_ERROR_TELL_TOKEN: 'test-token' }, windowsHide: true, shell: true });
let ready = false, exitCode = null;
server.on('exit', (c) => { exitCode = c; });
server.stderr?.on('data', () => {});
for (let i = 0; i < 30; i++) {
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status === 200) { ready = true; break; } } catch {}
  if (exitCode !== null) break;
  await new Promise(r2 => setTimeout(r2, 1000));
}
ok(ready && exitCode === null, '[C] web 服务就绪且宿主存活');
let html1 = '';
try { html1 = await (await fetch('http://127.0.0.1:' + PORT + '/')).text(); } catch {}
ok(html1.includes('// dsh-error-tell 注入脚本'), '[C] 注入脚本存在');
ok(html1.includes('fixture-bad-client'), '[C] __DSH_BOOT__ 含坏 client 行');
const dis = await fetch('http://127.0.0.1:' + PORT + '/api/error-tell/disable', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' },
  body: JSON.stringify({ rowId: '@dsh-error-tell/fixture-bad-client' })
}).then(r => r.json()).catch(e => ({ error: e.message }));
ok(dis.ok === true, '[C] 禁用端点 ok');
let html2 = '';
for (let i = 0; i < 10; i++) {
  await new Promise(r2 => setTimeout(r2, 1000));
  try { html2 = await (await fetch('http://127.0.0.1:' + PORT + '/')).text(); } catch {}
  if (!html2.includes('fixture-bad-client')) break;
}
ok(!html2.includes('fixture-bad-client'), '[C] 禁用后组合图排除坏行');
const patchC = readFileSync(join(homeC, 'cordis.patch.yml'), 'utf8');
ok(patchC.includes('- id: fixture-bad-client') && patchC.includes('disabled: true'), '[C] home patch 已禁用');
try { execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { server.kill(); }

// ===== Phase D ===== 
const homeD = join(tmp, 'homeD');
mkProfile(homeD, { '@dsh-error-tell/fixture-bad-import': fileDep('packages/test-fixtures/bad-import') }, ['- insert:', '    - id: fixture-bad-import', "      name: '@dsh-error-tell/fixture-bad-import'"]);
const envD = { ...process.env, DSH_HOME: homeD, DSH_TELEMETRY_DISABLED: '1' };
const instD = await run('pnpm', ['install', '--offline'], { cwd: join(homeD, 'profiles', 'web'), timeoutMs: 60000 });
ok(instD.code === 0, '[D] pnpm install exit=' + instD.code);
const dryD = await run('node', [BIN, 'guard', '--profile', 'web', '--dry-run'], { env: envD, timeoutMs: 45000 });
ok(dryD.stdout.includes('[error/import] fixture-bad-import'), '[D] dry-run 预检发现 import 失败行');
const gD = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envD, DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' }, timeoutMs: 60000 });
const jD = JSON.parse((gD.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jD.ok === true && jD.attempts === 1 && jD.disabled.includes('fixture-bad-import'), '[D] 预检拦截：一次启动成功 attempts=' + jD.attempts + ' disabled=' + JSON.stringify(jD.disabled));

rmSync(tmp, { recursive: true, force: true });
console.log('=== Phase C+D 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
