// e2e 辅助模块的回归测试。
// 覆盖三类此前只有人工检查、没有测试保护的行为：
//   1) shell:true 参数安全（P2：cmd.exe 会展开 %，控制字符会截断命令）
//   2) dsh stdout 的 web URL 解析（P2：端口改造依赖它，含 LAN 后缀与无 token 两种形态）
//   3) 超时后无孤儿进程（P1：detached + killTree 必须真的清掉整棵进程树）
// 全部不需要监听端口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeArg, buildCommandLine, originOf, parseWebUrl, quoteArg, run } from './helpers.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 1) 参数安全 ----------
test('assertSafeArg：控制字符（含换行）一律拒绝——它们会截断/篡改 shell 命令', () => {
  assert.throws(() => assertSafeArg('a\nb'), /控制字符/);
  assert.throws(() => assertSafeArg('a\rb'), /控制字符/);
  assert.throws(() => assertSafeArg('a\u0000b'), /控制字符/);
  assert.throws(() => assertSafeArg('a\u001bb'), /控制字符/);
  assert.equal(assertSafeArg('C:\\Temp\\normal path\\x.yml'), 'C:\\Temp\\normal path\\x.yml', '普通路径放行');
});

test('assertSafeArg：% 仅在 win32 拒绝（cmd.exe 引号内仍会展开 %VAR%）', () => {
  const pct = 'C:\\Users\\me\\100%done\\x.yml';
  if (process.platform === 'win32') {
    assert.throws(() => assertSafeArg(pct), /%/);
  } else {
    assert.equal(assertSafeArg(pct), pct, 'POSIX sh 不展开 %，不应拒绝');
  }
});

test('buildCommandLine：会校验所有参数（含 bin）并做平台转义', () => {
  assert.throws(() => buildCommandLine('dsh', ['ok', 'bad\narg']), /控制字符/);
  assert.throws(() => buildCommandLine('bad\nbin', ['ok']), /控制字符/);
  const line = buildCommandLine('dsh', ['--profile', 'web']);
  assert.match(line, /--profile/);
  assert.match(line, /web/);
  assert.ok(line.startsWith(quoteArg('dsh')), '以转义后的 bin 开头：' + line);
});

// ---------- 2) web URL 解析 ----------
test('parseWebUrl：带 token 与 LAN 后缀时取第一个 URL', () => {
  const out = 'starting...\ndsh web: http://127.0.0.1:53421/?token=AbC-123_xy (LAN: http://192.168.1.9:53421/?token=ZzZ)\n';
  assert.equal(parseWebUrl(out), 'http://127.0.0.1:53421/?token=AbC-123_xy');
  assert.equal(originOf(parseWebUrl(out)), 'http://127.0.0.1:53421');
});

test('parseWebUrl：0.1.0-rc.6 的无 token 形态', () => {
  const out = 'dsh web: http://127.0.0.1:3080/\n';
  assert.equal(parseWebUrl(out), 'http://127.0.0.1:3080/');
  assert.equal(originOf(parseWebUrl(out)), 'http://127.0.0.1:3080');
});

test('parseWebUrl：不得误匹配同前缀的提示行，未就绪时返回 null', () => {
  assert.equal(parseWebUrl('dsh web: opening the default browser; pass --no-open to disable'), null);
  assert.equal(parseWebUrl(''), null);
  assert.equal(parseWebUrl(undefined), null);
  assert.equal(originOf(null), null, 'originOf 对 null 返回 null 而不是抛错');
  assert.equal(originOf('not a url'), null);
});

// ---------- 3) 超时后无孤儿进程（P1 回归） ----------
test('run：超时会杀掉整棵进程树，孙进程不再存活（P1 孤儿进程回归）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'det-orphan-'));
  const heartbeat = join(dir, 'heartbeat.txt');
  const grandchild = join(dir, 'grandchild.mjs');
  const child = join(dir, 'child.mjs');
  // 孙进程：每 100ms 追加一个字节（被清理后应停止增长）
  writeFileSync(grandchild, [
    "import { appendFileSync } from 'node:fs';",
    'const target = process.argv[2];',
    "setInterval(() => { try { appendFileSync(target, 'x'); } catch {} }, 100);"
  ].join('\n'), 'utf8');
  // 子进程：拉起孙进程（stdio ignore，避免管道干扰），自己挂住不退出
  writeFileSync(child, [
    "import { spawn } from 'node:child_process';",
    'const [grandchild, target] = process.argv.slice(2);',
    "spawn(process.execPath, [grandchild, target], { stdio: 'ignore' });",
    'setTimeout(() => {}, 60000);'
  ].join('\n'), 'utf8');

  try {
    const res = await run('node', [child, grandchild, heartbeat], { timeoutMs: 2000 });
    assert.equal(res.timedOut, true, '应当在 2s 超时');
    assert.ok(statSync(heartbeat).size > 0, '超时前孙进程确实在写（用例前提成立）');

    await sleep(400);                 // 给 killTree 一点收敛时间
    const size1 = statSync(heartbeat).size;
    await sleep(600);
    const size2 = statSync(heartbeat).size;
    assert.equal(size2, size1, '超时后孙进程应已被清理，心跳不再增长（孤儿进程泄漏）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
