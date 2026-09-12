// S3：client-tell 禁用端点 maxDisable 熔断（DSH_ERROR_TELL_MAX_DISABLE=1 时第二个禁用返回 429）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkProfile } from './link-profile.mjs';
// P1：统一辅助模块——参数转义/超时杀进程树/POSIX 进程组都只有一份实现
import { originOf, parseWebUrl, run, startServer } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tmp = mkdtempSync(join((await import('node:os')).tmpdir(), 'det-s3c-'));
let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('✖ FAIL:', msg); } else console.log('✔', msg); }

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

linkProfile(profileDir, {
  '@dsh-error-tell/client-tell': 'packages/client-tell',
  '@dsh-error-tell/core': 'packages/core',
  '@dsh-error-tell/fixture-bad-client': 'packages/test-fixtures/bad-client'
});
ok(true, '[S3C] 沙箱依赖已链接（junction）');

// M5：不预先探测端口（原「探针→关闭→再绑定」有 TOCTOU 竞态）；从 dsh 打印的 URL 取实际端口
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_ERROR_TELL_TOKEN: 'test-token', DSH_ERROR_TELL_MAX_DISABLE: '1' };
const server = startServer('dsh', ['--profile', 'web', '--port', '0'], { env });
const origin = () => originOf(parseWebUrl(server.stdout()));
let ready = false;
for (let i = 0; i < 90; i++) {
  try { const r = await fetch(origin() + '/'); if (r.status === 200) { ready = true; break; } } catch {}
  if (!server.alive()) break;
  await new Promise(r2 => setTimeout(r2, 1000));
}
ok(ready && server.alive(), '[S3C] web 服务就绪且宿主存活');

const H = { 'content-type': 'application/json', 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' };
const d1 = await fetch(origin() + '/api/error-tell/disable', { method: 'POST', headers: H, body: JSON.stringify({ rowId: 'fixture-bad-client' }) });
const j1 = await d1.json().catch(() => ({}));
ok(d1.status === 200 && j1.ok === true, '[S3C] 第 1 个禁用成功（200）');
const d2 = await fetch(origin() + '/api/error-tell/disable', { method: 'POST', headers: H, body: JSON.stringify({ rowId: 'fixture-bad-client-2' }) });
const j2 = await d2.json().catch(() => ({}));
ok(d2.status === 429 && j2.ok === false, '[S3C] 达上限后第 2 个禁用返回 429（status=' + d2.status + '）');
const patchText = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
ok(patchText.includes('- id: fixture-bad-client') && !patchText.includes('- id: fixture-bad-client-2'), '[S3C] managed 段只含 1 行（熔断未越限写入）');

server.stop();
rmSync(tmp, { recursive: true, force: true });
console.log('=== S3C 完成，失败数:', failed, '===');
process.exit(failed ? 1 : 0);
