// Phase C 独立验证：client-tell 注入 + 禁用端点 + 组合图排除
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkProfile } from './link-profile.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmp = mkdtempSync(join((await import('node:os')).tmpdir(), 'det-c-'));
let failed = 0;
function ok(c, m) { if (!c) { failed++; console.error('✖ FAIL:', m); } else console.log('✔', m); }
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cmdline = [cmd, ...args.map(a => '"' + String(a).replace(/"/g, '\\"') + '"')].join(' ');
    const child = spawn(cmdline, { ...opts, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true, shell: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, stdout: out, stderr: err, timedOut: true }); }, opts.timeoutMs || 60000);
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => err += d);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}
const fileDep = (p) => 'file:' + join(ROOT, p).replaceAll('\\', '/');
function mkProfile(home, deps, rows) {
  const profileDir = join(home, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: deps, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2) + '\n');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), rows.join('\n') + '\n');
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  return profileDir;
}

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
ok(true, '[C] 沙箱依赖已链接（junction，替代 pnpm workspace 解析）');
const envC = { ...process.env, DSH_HOME: homeC, DSH_TELEMETRY_DISABLED: '1' };
// M5：随机空闲端口（避免固定端口冲突）
import { createServer as createProbeServer } from 'node:net';
const PORT = await new Promise((res) => { const s = createProbeServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn('dsh', ['--profile', 'web', '--port', String(PORT)], { env: { ...envC, DSH_ERROR_TELL_TOKEN: 'test-token' }, windowsHide: true, shell: true });
let ready = false, exitCode = null;
server.on('exit', (c) => { exitCode = c; });
server.stderr?.on('data', () => {});
for (let i = 0; i < 90; i++) {
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status === 200) { ready = true; break; } } catch {}
  if (exitCode !== null) break;
  await new Promise(r2 => setTimeout(r2, 1000));
}
ok(ready && exitCode === null, '[C] web 服务就绪且宿主存活');
let html1 = '';
try { html1 = await (await fetch('http://127.0.0.1:' + PORT + '/')).text(); } catch {}
ok(html1.includes('// dsh-error-tell 注入脚本'), '[C] 注入脚本存在');
ok(html1.includes('fixture-bad-client'), '[C] __DSH_BOOT__ 含坏 client 行');
ok(html1.includes('client-tell/client.js'), '[C] __DSH_BOOT__ 含 client-tell 客户端模块（设置分区 bundle）');
const dis = await fetch('http://127.0.0.1:' + PORT + '/api/error-tell/disable', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' },
  body: JSON.stringify({ rowId: '@dsh-error-tell/fixture-bad-client' })
}).then(r => r.json()).catch(e => ({ error: e.message }));
ok(dis.ok === true, '[C] 禁用端点 ok');
// 状态端点：返回插件功能描述（package.json description），帮助使用者排错
const stC = await fetch('http://127.0.0.1:' + PORT + '/api/error-tell/status', { headers: { 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' } }).then(r2 => r2.json()).catch(e => ({ error: e.message }));
const recC = (stC.disabled || []).find(x => x.rowId === 'fixture-bad-client');
ok(recC && recC.disabled === true, '[C] status 标注已禁用');
ok(recC && recC.desc && recC.desc.includes('e2e 坏插件'), '[C] status 返回插件功能描述（desc）');
let html2 = '';
for (let i = 0; i < 10; i++) {
  await new Promise(r2 => setTimeout(r2, 1000));
  try { html2 = await (await fetch('http://127.0.0.1:' + PORT + '/')).text(); } catch {}
  if (!html2.includes('fixture-bad-client')) break;
}
ok(!html2.includes('fixture-bad-client'), '[C] 禁用后组合图排除坏行');
// /plugins 端点：设置页「错误看门狗」数据源（读取全部插件 + 手动禁用状态）
const plC = await fetch('http://127.0.0.1:' + PORT + '/api/error-tell/plugins', { headers: { 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' } }).then(r2 => r2.json()).catch(e => ({ error: e.message }));
const recP = (plC.plugins || []).find(x => x.rowId === 'fixture-bad-client');
ok(plC.ok === true && !!recP, '[C] /plugins 列表包含 fixture 行');
ok(recP.disabled === true && recP.managed === true, '[C] /plugins 反映已禁用(managed)');
ok(recP.protected === false && recP.guard === false, '[C] /plugins 普通行标记为可操作');
ok(recP.desc && recP.desc.includes('e2e 坏插件'), '[C] /plugins 行带功能描述');
const patchC = readFileSync(join(homeC, 'cordis.patch.yml'), 'utf8');
ok(patchC.includes('- id: fixture-bad-client') && patchC.includes('disabled: true'), '[C] home patch 已禁用');
try { execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { server.kill(); }

