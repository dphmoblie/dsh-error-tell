// e2e：沙箱 DSH_HOME 全链路（坏插件 → 失败 → guard 禁用 → 重启成功 → restore）
// 不触碰真实 ~/.dsh。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const FIXTURE = join(ROOT, 'packages', 'test-fixtures', 'bad-apply');

const tmp = mkdtempSync(join(tmpdir(), 'dsh-error-tell-e2e-'));
const home = join(tmp, 'home');
const profileDir = join(home, 'profiles', 'web');
mkdirSync(profileDir, { recursive: true });

const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, env: { ...env, ...(opts.env || {}) }, windowsHide: true, shell: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, stdout: out, stderr: err, timedOut: true }); }, opts.timeoutMs || 120000);
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => err += d);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout: out, stderr: err, error: e.message }); });
  });
}

function ok(cond, msg) {
  if (!cond) { console.error('✖ FAIL:', msg); process.exitCode = 1; } else console.log('✔', msg);
}

// 1) 手工构造 profile（bundles: base + web-app；依赖: bad-apply fixture）
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { '@dsh-error-tell/fixture-bad-apply': 'file:' + FIXTURE.replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2) + '\n', 'utf8');
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '- insert:',
    '    - id: fixture-bad-apply',
      "      name: '@dsh-error-tell/fixture-bad-apply'",
  ''
].join('\n'), 'utf8');
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');

// 2) 安装 fixture（file: 依赖，offline）
const inst = await run('pnpm', ['install', '--offline'], { cwd: profileDir, timeoutMs: 90000 });
ok(inst.code === 0, 'pnpm install fixture（offline）exit=' + inst.code + (inst.code === 0 ? '' : ' :: ' + (inst.stderr || '').slice(0, 400)));
ok(existsSync(join(profileDir, 'node_modules', '@dsh-error-tell', 'fixture-bad-apply', 'index.mjs')), 'fixture 已链接到 profile node_modules');

// 3) dump-config 能看到 fixture 行
const dump = await run('dsh', ['--profile', 'web', '--dump-config'], { env, timeoutMs: 90000 });
ok(dump.code === 0 && dump.stdout.includes('fixture-bad-apply'), 'dump-config 包含 fixture 行');

// 4) 真实启动：坏插件 apply 抛错 → exit 1
const boot = await run('dsh', ['--profile', 'web', '--port', '0'], { env, timeoutMs: 90000 });
ok(boot.code === 1, '坏插件启动失败（exit 1）');
ok((boot.stderr + boot.stdout).includes('fixture-bad-apply'), 'stderr 归因到 fixture-bad-apply');

// 5) guard：先失败归因 → 禁用 → 重启成功（quit 钩子 20s 后结束）
const g = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1', '--timeout-ms', '120000'], { env: { ...env, DSH_ERROR_TELL_QUIT_AFTER_MS: '20000' }, timeoutMs: 150000 });
const gjson = (g.stdout.match(/\{[\s\S]*\}/) || [''])[0];
let parsed = null;
try { parsed = JSON.parse(gjson); } catch { /* 无 JSON 输出 */ }
console.log('--- guard stdout ---');
console.log(g.stdout.slice(0, 2500));
console.log('--- guard stderr ---');
console.log(g.stderr.slice(0, 1500));
ok(parsed?.ok === true, 'guard 最终判定 ok（web 正常启动）');
ok(parsed?.attempts >= 2, 'guard 发生过重启（attempts=' + parsed?.attempts + '）');

// 6) 验证落盘：managed 段 + 账本
const patchText = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
ok(patchText.includes('- id: fixture-bad-apply') && patchText.includes('disabled: true'), 'home patch 已禁用 fixture 行');
const ledgerPath = join(home, 'state', 'dsh-error-tell', 'quarantine.json');
ok(existsSync(ledgerPath), 'quarantine 账本存在');
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
ok(ledger.entries.some(e => e.rowId === 'fixture-bad-apply' && !e.restoredAt), '账本含活动中条目');

// 7) 再次 dump-config：行已 disabled
const dump2 = await run('dsh', ['--profile', 'web', '--dump-config'], { env, timeoutMs: 90000 });
ok(/id: fixture-bad-apply[\s\S]*?disabled: true/.test(dump2.stdout), '禁用后组合配置中该行 disabled: true');

// 8) restore：清除禁用 + 账本标记恢复
const rs = await run('node', [BIN, 'restore', 'fixture-bad-apply'], { env, timeoutMs: 30000 });
ok(rs.code === 0 && rs.stdout.includes('已恢复'), 'restore 成功');
const patchAfter = readFileSync(join(home, 'cordis.patch.yml'), 'utf8');
ok(!patchAfter.includes('- id: fixture-bad-apply'), 'restore 后 managed 段移除该行');


// ===== Phase B：runtime-guard 插件自身捕获（宿主内同步落盘） =====
const homeB = join(tmp, 'homeB');
const profileB = join(homeB, 'profiles', 'web');
mkdirSync(profileB, { recursive: true });
writeFileSync(join(profileB, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: {
    '@dsh-error-tell/fixture-bad-apply': 'file:' + FIXTURE.replaceAll('\\', '/'),
    '@dsh-error-tell/runtime-guard': 'file:' + join(ROOT, 'packages', 'runtime-guard').replaceAll('\\', '/')
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-error-tell/runtime-guard'] } }
}, null, 2) + '\n', 'utf8');
writeFileSync(join(profileB, 'cordis.patch.yml'), [
  '- insert:',
    '    - id: fixture-bad-apply',
      "      name: '@dsh-error-tell/fixture-bad-apply'",
  ''
].join('\n'), 'utf8');
writeFileSync(join(profileB, 'cordis.yml'), '[]\n', 'utf8');
const envB = { ...env, DSH_HOME: homeB };
const instB = await run('pnpm', ['install', '--offline'], { cwd: profileB, timeoutMs: 90000 });
ok(instB.code === 0, '[B] pnpm install（offline）exit=' + instB.code);
const bootB = await run('dsh', ['--profile', 'web', '--port', '0'], { env: envB, timeoutMs: 90000 });
ok(bootB.code === 1, '[B] 坏插件启动失败（exit 1）');
let rgLedger = null;
try { rgLedger = JSON.parse(readFileSync(join(homeB, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8')); } catch { /* 未落盘 */ }
ok(!!rgLedger && rgLedger.entries.some(e2 => e2.rowId === 'fixture-bad-apply' && e2.source === 'runtime-guard'), '[B] runtime-guard 已在进程退出前同步落盘账本');
let rgPatch = '';
try { rgPatch = readFileSync(join(homeB, 'cordis.patch.yml'), 'utf8'); } catch { /* 未写 */ }
ok(rgPatch.includes('- id: fixture-bad-apply') && rgPatch.includes('disabled: true'), '[B] runtime-guard 已写入 managed 禁用段');

// ===== Phase C：client-tell —— 加载页注入 + 禁用端点 + 组合图排除 ===== 
const PORT_C = 31880;
const homeC = join(tmp, 'homeC');
const profileC = join(homeC, 'profiles', 'web');
mkdirSync(profileC, { recursive: true });
writeFileSync(join(profileC, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: {
    '@dsh-error-tell/client-tell': 'file:' + join(ROOT, 'packages', 'client-tell').replaceAll('\\', '/'),
    '@dsh-error-tell/fixture-bad-client': 'file:' + join(ROOT, 'packages', 'test-fixtures', 'bad-client').replaceAll('\\', '/')
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-error-tell/client-tell'] } }
}, null, 2) + '\n', 'utf8');
writeFileSync(join(profileC, 'cordis.patch.yml'), [
  '- insert:',
    '    - id: fixture-bad-client',
      "      name: '@dsh-error-tell/fixture-bad-client'",
  ''
].join('\n'), 'utf8');
writeFileSync(join(profileC, 'cordis.yml'), '[]\n', 'utf8');
const envC = { ...env, DSH_HOME: homeC };
const instC = await run('pnpm', ['install', '--offline'], { cwd: profileC, timeoutMs: 90000 });
ok(instC.code === 0, '[C] pnpm install（offline）exit=' + instC.code);
const serverC = spawn('dsh', ['--profile', 'web', '--port', String(PORT_C)], { env: envC, windowsHide: true, shell: true });
let serverOut = '', serverErr = '';
serverC.stdout?.on('data', d => serverOut += d);
serverC.stderr?.on('data', d => serverErr += d);
let readyC = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch('http://127.0.0.1:' + PORT_C + '/'); if (r.status === 200) { readyC = true; break; } } catch { /* 未就绪 */ }
  await new Promise(r2 => setTimeout(r2, 1000));
}
ok(readyC, '[C] web 服务已就绪（宿主正常，坏的是浏览器侧 client bundle）');
let html1 = '';
try { html1 = await (await fetch('http://127.0.0.1:' + PORT_C + '/')).text(); } catch { /* 忽略 */ }
ok(html1.includes('dsh-error-tell-inject'), '[C] 注入脚本已出现在 index.html');
ok(html1.includes('fixture-bad-client'), '[C] __DSH_BOOT__ 含坏 client 行（浏览器将白屏失败）');
const disableRes = await fetch('http://127.0.0.1:' + PORT_C + '/api/error-tell/disable', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-error-tell': '1' },
  body: JSON.stringify({ rowId: '@dsh-error-tell/fixture-bad-client' })
}).then(r => r.json()).catch(e => ({ error: e.message }));
ok(disableRes.ok === true, '[C] 禁用端点返回 ok（' + JSON.stringify(disableRes) + '）');
let html2 = '';
for (let i = 0; i < 10; i++) {
  await new Promise(r2 => setTimeout(r2, 1000));
  try { html2 = await (await fetch('http://127.0.0.1:' + PORT_C + '/')).text(); } catch { /* 重试 */ }
  if (!html2.includes('fixture-bad-client')) break;
}
ok(!html2.includes('fixture-bad-client'), '[C] 禁用后新页面 __DSH_BOOT__ 已排除坏 client 行（刷新即恢复正常）');
const patchC = readFileSync(join(homeC, 'cordis.patch.yml'), 'utf8');
ok(patchC.includes('- id: fixture-bad-client') && patchC.includes('disabled: true'), '[C] home patch 已禁用（source=client-tell）');
const ledgerC = JSON.parse(readFileSync(join(homeC, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
ok(ledgerC.entries.some(e2 => e2.rowId === 'fixture-bad-client' && e2.source === 'client-tell'), '[C] 账本记录 source=client-tell');
try { execFileSync('taskkill', ['/PID', String(serverC.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { serverC.kill(); }

// ===== Phase D：宿主 import 失败 —— boot-guard 预检拦截（无需重启） =====
const homeD = join(tmp, 'homeD');
const profileD = join(homeD, 'profiles', 'web');
mkdirSync(profileD, { recursive: true });
writeFileSync(join(profileD, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { '@dsh-error-tell/fixture-bad-import': 'file:' + join(ROOT, 'packages', 'test-fixtures', 'bad-import').replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2) + '\n', 'utf8');
writeFileSync(join(profileD, 'cordis.patch.yml'), [
  '- insert:',
    '    - id: fixture-bad-import',
      "      name: '@dsh-error-tell/fixture-bad-import'",
  ''
].join('\n'), 'utf8');
writeFileSync(join(profileD, 'cordis.yml'), '[]\n', 'utf8');
const envD = { ...env, DSH_HOME: homeD };
const instD = await run('pnpm', ['install', '--offline'], { cwd: profileD, timeoutMs: 90000 });
ok(instD.code === 0, '[D] pnpm install exit=' + instD.code);
const dryD = await run('node', [BIN, 'guard', '--profile', 'web', '--dry-run'], { env: envD, timeoutMs: 60000 });
ok(dryD.stdout.includes('[error/import] fixture-bad-import'), '[D] dry-run 预检发现 import 失败行');
const gD = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envD, DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' }, timeoutMs: 90000 });
const jD = JSON.parse((gD.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jD.ok === true && jD.attempts === 1, '[D] import 失败被预检拦截：无需重启直接正常启动（attempts=' + jD.attempts + '）');
ok(jD.disabled.includes('fixture-bad-import'), '[D] 禁用列表含 fixture-bad-import');

// ===== Phase E：幂等性 —— 无坏插件时零副作用（验收标准 #3）=====
const homeE = join(tmp, 'homeE');
const profileE = join(homeE, 'profiles', 'web');
mkdirSync(profileE, { recursive: true });
writeFileSync(join(profileE, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2) + '\n', 'utf8');
writeFileSync(join(profileE, 'cordis.patch.yml'), '# 干净 profile\n', 'utf8');
writeFileSync(join(profileE, 'cordis.yml'), '[]\n', 'utf8');
const envE = { ...env, DSH_HOME: homeE };
const instE = await run('pnpm', ['install', '--offline'], { cwd: profileE, timeoutMs: 90000 });
ok(instE.code === 0, '[E] pnpm install exit=' + instE.code);
const gE = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envE, DSH_ERROR_TELL_QUIT_AFTER_MS: '15000' }, timeoutMs: 90000 });
const jE = JSON.parse((gE.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jE.ok === true && jE.attempts === 1 && jE.disabled.length === 0, '[E] 干净 profile：一次启动成功，未禁用任何行');
ok(!existsSync(join(homeE, 'cordis.patch.yml')), '[E] 未创建 home patch（零副作用）');
ok(!existsSync(join(homeE, 'state', 'dsh-error-tell')), '[E] 未创建隔离账本（零副作用）');
// ===== Phase F：home patch YAML 损坏 —— guard 友好失败，不改配置 =====
const homeF = join(tmp, 'homeF');
mkdirSync(join(homeF, 'profiles'), { recursive: true });
writeFileSync(join(homeF, 'cordis.patch.yml'), '::::broken::::\n', 'utf8');
const envF = { ...env, DSH_HOME: homeF };
const gF = await run('node', [BIN, 'guard', '--profile', 'web'], { env: envF, timeoutMs: 60000 });
ok(gF.code === 6, '[F] YAML 损坏时 guard 退出码 6（' + gF.code + '）');
ok((gF.stderr + gF.stdout).includes('guard 失败'), '[F] 输出友好错误信息');
ok(!existsSync(join(homeF, 'state', 'dsh-error-tell', 'quarantine.json')), '[F] 未写隔离账本（不改配置）');

// ===== Phase G：多坏插件（import + apply）一次清理 ===== 
const homeG = join(tmp, 'homeG');
const profileG = join(homeG, 'profiles', 'web');
mkdirSync(profileG, { recursive: true });
writeFileSync(join(profileG, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: {
    '@dsh-error-tell/fixture-bad-import': 'file:' + join(ROOT, 'packages', 'test-fixtures', 'bad-import').replaceAll('\\', '/'),
    '@dsh-error-tell/fixture-bad-apply': 'file:' + FIXTURE.replaceAll('\\', '/')
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2) + '\n', 'utf8');
writeFileSync(join(profileG, 'cordis.patch.yml'), [
  '- insert:',
    '    - id: fixture-bad-import',
      "      name: '@dsh-error-tell/fixture-bad-import'",
    '    - id: fixture-bad-apply',
      "      name: '@dsh-error-tell/fixture-bad-apply'",
  ''
].join('\n'), 'utf8');
writeFileSync(join(profileG, 'cordis.yml'), '[]\n', 'utf8');
const envG = { ...env, DSH_HOME: homeG };
const instG = await run('pnpm', ['install', '--offline'], { cwd: profileG, timeoutMs: 90000 });
ok(instG.code === 0, '[G] pnpm install exit=' + instG.code);
const gG = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1'], { env: { ...envG, DSH_ERROR_TELL_QUIT_AFTER_MS: '25000' }, timeoutMs: 150000 });
const jG = JSON.parse((gG.stdout.match(/\{[\s\S]*\}/) || ['{}'])[0]);
ok(jG.ok === true && jG.attempts >= 2, '[G] 多坏插件：预检 + 归因两次禁用后正常启动（attempts=' + jG.attempts + '）');
ok(jG.disabled.includes('fixture-bad-import') && jG.disabled.includes('fixture-bad-apply'), '[G] 两个坏行都在禁用列表');
const ledgerG = JSON.parse(readFileSync(join(homeG, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8'));
ok(ledgerG.entries.filter(e2 => !e2.restoredAt).length === 2, '[G] 账本含 2 条活动中记录');
// 9) 清理
rmSync(tmp, { recursive: true, force: true });
console.log('e2e 完成，临时目录已清理:', tmp);
