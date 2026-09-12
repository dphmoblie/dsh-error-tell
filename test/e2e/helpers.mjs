// e2e 统一辅助模块。
//
// 为什么要有这个文件：此前每个 e2e 脚本各自抄了一份 run()，实现互不一致——
// 有的用内联引号拼接（`'"' + a.replace(/"/g,'\\"') + '"'`，这是 POSIX 写法，在 Windows cmd 下
// 遇到反斜杠/引号就会错），有的超时只调 child.kill()（只杀 shell，留下孤儿 dsh）。
// 统一到这里：参数转义走 compose.quoteArg（含参数安全校验），超时清理走 compose.killTree，
// POSIX 下统一 detached 以便按进程组杀干净。
import { spawn } from 'node:child_process';
import { assertSafeArg, buildCommandLine, killTree, quoteArg } from '../../packages/boot-guard/src/compose.mjs';

export { assertSafeArg, buildCommandLine, killTree, quoteArg };

/** shell:true 下拼命令串（已做安全校验 + 平台转义）。 */
export function shellCmd(cmd, args) { return buildCommandLine(cmd, args); }

/** 子进程默认带 POSIX 进程组，保证 killTree 能按组杀干净。 */
function spawnOpts(opts = {}) {
  return {
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
    windowsHide: true,
    shell: true,
    detached: process.platform !== 'win32'
  };
}

/**
 * 运行一个命令直到结束或超时。
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, error?:string}>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shellCmd(cmd, args), spawnOpts(opts));
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: String(e?.message ?? e) });
      return;
    }
    let out = '', err = '', settled = false;
    let timer = null;
    const finish = (r) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };
    timer = setTimeout(() => { killTree(child); finish({ code: null, stdout: out, stderr: err, timedOut: true }); }, opts.timeoutMs || 120000);
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => err += d);
    child.on('close', (code) => finish({ code, stdout: out, stderr: err, timedOut: false }));
    child.on('error', e => finish({ code: null, stdout: out, stderr: err, timedOut: false, error: e.message }));
  });
}

/**
 * 启动一个常驻子进程（如 `dsh web`），返回句柄以便边读 stdout 边断言。
 * 调用方负责在结束时调 stop()（走 killTree，按进程组清理）。
 */
export function startServer(cmd, args, opts = {}) {
  let child;
  try {
    child = spawn(shellCmd(cmd, args), spawnOpts(opts));
  } catch (e) {
    throw new Error('启动失败: ' + (e?.message ?? e));
  }
  let out = '', err = '';
  let exitCode = null;
  child.stdout?.on('data', d => out += d);
  child.stderr?.on('data', d => err += d);
  child.on('exit', (c) => { exitCode = c; });
  child.on('error', () => { /* 由 exitCode 反映 */ });
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exitCode: () => exitCode,
    alive: () => exitCode === null,
    stop: () => killTree(child)
  };
}

/**
 * 从 dsh stdout 解析 web URL。
 *
 * 实测形态（dsh-web-app/lib/index.js:197-203，localWebUrl 用的是 ctx.get("webServer").port）：
 *   - 0.1.x 带会话认证：`dsh web: http://127.0.0.1:PORT/?token=XXX (LAN: http://IP:PORT/?token=YYY)`
 *   - 0.1.0-rc.6 无 token：`dsh web: http://127.0.0.1:PORT/`
 * `[^\s(]+` 在空格或 `(LAN:` 前停下，因此两种情况都能取到第一个 URL；
 * `https?://` 锚点则保证不会误匹配同前缀的提示行
 * （如 `dsh web: opening the default browser; pass --no-open to disable`）。
 */
export function parseWebUrl(text) {
  const m = /dsh web:\s*(https?:\/\/[^\s(]+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** 取 origin（协议+主机+端口），取不到返回 null。 */
export function originOf(webUrl) {
  try { return new URL(webUrl).origin; } catch { return null; }
}

/** 轮询直到 cond() 为真或次数用尽。cond 抛错视为未就绪。 */
export async function waitFor(cond, { tries = 90, delayMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await cond()) return true; } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}
