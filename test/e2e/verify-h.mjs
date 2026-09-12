// Phase H 独立验证：apply 挂起 → 进程级超时 → 熔断（零配置修改）。
// M6：Phase H 原先只在 run-e2e.mjs 全量脚本里，而全量脚本属于手动触发的 CI job；
// 抽成独立脚本后可以进 fast job，让挂起超时这条路径每次 CI 都被覆盖。
//
// 注意：本脚本需要 `dsh web` 绑定一个临时端口（--port 0），在禁止开端口的环境里跑不了。
// 它依赖 guard 预检不再误报官方包（见 guard.detectDshInstall），否则官方行会被记进账本、
// 令下面的「零配置修改」断言失败。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkProfile } from './link-profile.mjs';
// P1：统一辅助模块——参数转义/超时杀进程树/POSIX 进程组都只有一份实现
import { run } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'packages', 'boot-guard', 'bin', 'dsh-error-tell.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'det-h-'));
let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('✖ FAIL:', msg); } else console.log('✔', msg); }

// 取 stdout 中最后一个 guard 结果 JSON（避免贪婪匹配吞掉日志花括号）
function parseLastJson(out) {
  const candidates = [...String(out || '').matchAll(/\{[\s\S]*?\n\}/g)].map(m => m[0]);
  for (const c of [...candidates].reverse()) {
    try { const o = JSON.parse(c); if (o && 'ok' in o) return o; } catch { /* 跳过 */ }
  }
  return null;
}

const home = join(tmp, 'homeH');
const profileH = join(home, 'profiles', 'web');
mkdirSync(profileH, { recursive: true });
writeFileSync(join(profileH, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { '@dsh-error-tell/fixture-bad-hang': 'file:' + join(ROOT, 'packages', 'test-fixtures', 'bad-hang').replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2) + '\n', 'utf8');
writeFileSync(join(profileH, 'cordis.patch.yml'), [
  '- insert:',
  '    - id: fixture-bad-hang',
  "      name: '@dsh-error-tell/fixture-bad-hang'",
  ''
].join('\n'), 'utf8');
writeFileSync(join(profileH, 'cordis.yml'), '[]\n', 'utf8');
const envH = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
linkProfile(profileH, { '@dsh-error-tell/fixture-bad-hang': 'packages/test-fixtures/bad-hang' });
ok(true, '[H] 沙箱依赖已链接（junction）');

const gH = await run('node', [BIN, 'guard', '--profile', 'web', '--port', '0', '--restart-limit', '1', '--timeout-ms', '20000'], { env: envH, timeoutMs: 90000 });
const jH = parseLastJson(gH.stdout);
ok(gH.code === 5 && jH && jH.ok === false && jH.spawn?.timedOut === true, '[H] 挂起超时熔断（exit 5, timedOut）—— exit=' + gH.code);
const homePatch = existsSync(join(home, 'cordis.patch.yml'));
const stateDir = existsSync(join(home, 'state', 'dsh-error-tell'));
ok(!homePatch && !stateDir, '[H] 零配置修改（home patch=' + homePatch + ', state=' + stateDir + '）');
if (stateDir) {
  try { console.error('   state 内容:', readFileSync(join(home, 'state', 'dsh-error-tell', 'quarantine.json'), 'utf8').slice(0, 400)); } catch { /* */ }
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? ('Phase H 验证失败 ' + failed + ' 项') : 'Phase H 验证通过');
process.exit(failed ? 1 : 0);
