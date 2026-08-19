// e2e：沙箱 DSH_HOME 全链路（坏插件 → 失败 → guard 禁用 → 重启成功 → restore）
// 不触碰真实 ~/.dsh。
import { spawn } from 'node:child_process';
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
// 9) 清理
rmSync(tmp, { recursive: true, force: true });
console.log('e2e 完成，临时目录已清理:', tmp);
