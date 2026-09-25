// Phase C 独立验证：client-tell 注入 + 禁用端点 + 组合图排除
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkProfile } from './link-profile.mjs';
// P1：统一辅助模块——参数转义/超时杀进程树/POSIX 进程组都只有一份实现
import { dumpServer, originOf, parseWebUrl, run, startServer } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmp = mkdtempSync(join((await import('node:os')).tmpdir(), 'det-c-'));
let failed = 0;
function ok(c, m) { if (!c) { failed++; console.error('✖ FAIL:', m); } else console.log('✔', m); }
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
// M5：不预先探测端口。原「探针拿端口 → 关闭 → 让 dsh 绑同一端口」有 TOCTOU 竞态
// （关闭到绑定之间端口可能被抢 → EADDRINUSE，而它属环境类错误会被归因逻辑过滤，guard 只会熔断退出）。
// dsh 打印的 `dsh web: <url>?token=` 里就是实际绑定端口（web-app 用 ctx.get("webServer").port），
// 所以 `--port 0` 足够，从 stdout 取端口即可。
const server = startServer('dsh', ['--profile', 'web', '--port', '0', '--no-open'], { env: { ...envC, DSH_ERROR_TELL_TOKEN: 'test-token' } });
let ready = false;
const webUrlOf = () => parseWebUrl(server.stdout());
const origin = () => originOf(webUrlOf());
// 新版会话认证：带 token 的首页 303 → Set-Cookie → 干净路径带 cookie 访问
let sessionCookie = '';
async function pageFetch() {
  const base = origin();
  if (!base) throw new Error('dsh 尚未打印 web URL');
  const first = await fetch(webUrlOf(), { redirect: 'manual', headers: sessionCookie ? { cookie: sessionCookie } : {} });
  if (first.status === 303) {
    const sc = first.headers.get('set-cookie');
    if (sc) sessionCookie = sc.split(';')[0];
    return fetch(base + '/', { headers: sessionCookie ? { cookie: sessionCookie } : {} });
  }
  return first;
}
for (let i = 0; i < 90; i++) {
  try { const r = await pageFetch(); if (r.status === 200) { ready = true; break; } } catch {}
  if (!server.alive()) break;
  await new Promise(r2 => setTimeout(r2, 1000));
}
if (!(ready && server.alive())) dumpServer(server, 'dsh（Phase C）');
ok(ready && server.alive(), '[C] web 服务就绪且宿主存活' + (webUrlOf() ? '（已换会话 cookie）' : ''));
let html1 = '';
try { html1 = await (await pageFetch()).text(); } catch {}
ok(html1.includes('// dsh-error-tell 注入脚本'), '[C] 注入脚本存在');
ok(html1.includes('fixture-bad-client'), '[C] __DSH_BOOT__ 含坏 client 行');
ok(html1.includes('client-tell/client.js'), '[C] __DSH_BOOT__ 含 client-tell 客户端模块（设置分区 bundle）');
const dis = await fetch(origin() + '/api/error-tell/disable', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' },
  body: JSON.stringify({ rowId: '@dsh-error-tell/fixture-bad-client' })
}).then(r => r.json()).catch(e => ({ error: e.message }));
ok(dis.ok === true, '[C] 禁用端点 ok');
// 状态端点：返回插件功能描述（package.json description），帮助使用者排错
const stC = await fetch(origin() + '/api/error-tell/status', { headers: { 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' } }).then(r2 => r2.json()).catch(e => ({ error: e.message }));
const recC = (stC.disabled || []).find(x => x.rowId === 'fixture-bad-client');
ok(recC && recC.disabled === true, '[C] status 标注已禁用');
ok(recC && recC.desc && recC.desc.includes('e2e 坏插件'), '[C] status 返回插件功能描述（desc）');
let html2 = '';
for (let i = 0; i < 10; i++) {
  await new Promise(r2 => setTimeout(r2, 1000));
  try { html2 = await (await pageFetch()).text(); } catch {}
  if (!html2.includes('fixture-bad-client')) break;
}
ok(!html2.includes('fixture-bad-client'), '[C] 禁用后组合图排除坏行');
// /plugins 端点：设置页「错误哨兵」数据源（读取全部插件 + 手动禁用状态）
const plC = await fetch(origin() + '/api/error-tell/plugins', { headers: { 'x-dsh-error-tell': '1', 'x-dsh-error-token': 'test-token' } }).then(r2 => r2.json()).catch(e => ({ error: e.message }));
const recP = (plC.plugins || []).find(x => x.rowId === 'fixture-bad-client');
ok(plC.ok === true && !!recP, '[C] /plugins 列表包含 fixture 行');
// 注意：全部用 `!!recP &&` 兜底 —— 宿主没起来时 recP 是 undefined，
// 原来的 `recP.disabled` 会抛 TypeError 直接终止脚本，后面的检查（/plugins 分类、patch 落盘）就全部不报了。
ok(!!recP && recP.disabled === true && recP.managed === true, '[C] /plugins 反映已禁用(managed)');
ok(!!recP && recP.protected === false && recP.guard === false, '[C] /plugins 普通行标记为可操作');
ok(!!recP && recP.desc && recP.desc.includes('e2e 坏插件'), '[C] /plugins 行带功能描述');
// 分类：fixture 行由 profile 补丁插入 → user；error-tell host 行 → third；官方包行存在 → official
ok(!!recP && recP.kind === 'third', '[C] 补丁插入行按包归属归入 third（kind=' + (recP && recP.kind) + '）');
const hostRowC = (plC.plugins || []).find(x => x.rowId === 'error-tell-client-host');
ok(hostRowC && hostRowC.kind === 'third', '[C] error-tell host 行分类为 third');
ok((plC.plugins || []).some(x => x.kind === 'official'), '[C] 列表含官方插件行（@deepseek-ai/cordis:）');
const patchC = readFileSync(join(homeC, 'cordis.patch.yml'), 'utf8');
ok(patchC.includes('- id: fixture-bad-client') && patchC.includes('disabled: true'), '[C] home patch 已禁用');
server.stop();

