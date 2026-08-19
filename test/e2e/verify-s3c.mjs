// S3：client-tell 禁用端点 maxDisable 熔断（DSH_ERROR_TELL_MAX_DISABLE=1 时第二个禁用返回 429）
import { spawn } from 'node:child_process';
import { createServer as createProbeServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tmp = mkdtempSync(join(process.env.TEMP || 'C:\\Users\\user\\AppData\\Local\\Temp', 'det-s3c-'));
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
  });
}

const home = join(tmp, 'homeC');
const profileDir = join(home, 'profiles', 'web');
mkdirSync(profileDir, { recursive: true });
const fileDep = (p) => 'file:' + join(ROOT, p).replaceAll('\\', '/');
const pkg = {
  name: 'dsh-profile-web', private: true,
  dependencies: {
    '@dsh-error-tell/client-tell': fileDep('packages/client-tell'),
    '@dsh-error-tell/fixture-bad-client': fileDep('packages/test-fixtures/bad-client')
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-error-tell/client-tell'] } }
};
writeFileSync(join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
// 同一 fixture 包以两个 id 注入（bad-client 与 bad-client-2），浏览器侧都会失败
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '- insert:',
  '    - id: fixture-bad-client',
  "      name: '@dsh-error-tell/fixture-bad-client'",
  '    - id: fixture-bad-client-2',
  "      name: '@dsh-error-tell/fixture-bad-client'"
].join('\n') + '\n');
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');

const inst = await run('pnpm', ['install', '--offline'], { cwd: profileDir, timeoutMs: 60000 });
ok(inst.code === 0, '[S3C] pnpm install exit=' + inst.code);

const PORT = await new Promise((res) => { const s = createProbeServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_ERROR_TELL_TOKEN: 'test-token', DSH_ERROR_TELL_MAX_DISABLE: '1' };
const server = spawn('dsh', ['--profile', 'web', '--port', String(PORT)], { env, windowsHide: true, shell: true });
let exitCode = null;
server.on('exit', c => { exitCode = c; });
server.stderr?.on('data', () => {});
let ready = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status === 200) { ready = true; break; } } catch {}
  if (exitCode !== null) break;
  await new Promise(r2 => setTimeout(r2, 1000));
}
ok(ready && exitCode === null, '[S3C] web 服务就绪且宿主存活');

const H = { 'content-type': 'application/json', 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' };
const d1 = await fetch('http://127.0.0.1:' + PORT + '/api/error-tell/disable', { method: 'POST', headers: H, body: JSON.stringify({ rowId: 'fixture-bad-client' }) });
const j1 = await d1.json().catch(() => ({}));
ok(d1.status === 200 && j1.ok === true, '[S3C] 第 1 个禁用成功（200）');
const d2 = await fetch('http://127.0.0.1:' + PORT + '/api/error-tell/disable', { method: 'POST', headers: H, body: JSON.stringify({ rowId: 'fixture-bad-client-2' }) });
const j2 = await d2.json().catch(() => ({}));
ok(d2.status === 429 && j2.ok === false, '[S3C] 达上限后第 2 个禁用返回 429（status=' + d2.status + '）');
const patchText = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
ok(patchText.includes('- id: fixture-bad-client') && !patchText.includes('- id: fixture-bad-client-2'), '[S3C] managed 段只含 1 行（熔断未越限写入）');

try { await import('node:child_process').then(m => m.execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })); } catch { server.kill(); }
rmSync(tmp, { recursive: true, force: true });
console.log('=== S3C 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
