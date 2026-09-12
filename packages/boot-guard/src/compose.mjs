import { spawn, spawnSync } from 'node:child_process';

/** Windows 用 taskkill /T 杀进程树；POSIX 用负 pid 杀进程组。 */
export function killTree(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 已退出 */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  }
}

/**
 * 把单个参数转成可安全放进 `shell: true` 命令行的字面量。
 *
 * Windows 上 shell 是 cmd.exe，而子进程（node/dsh）用 MSVCRT 规则解析 argv：
 * 反斜杠是**字面量**，只有紧邻引号（或收尾引号）时才有转义含义。
 * 原实现照搬 POSIX 转义，把每个 `\` 都变成 `\\`，导致所有 Windows 路径都以
 * 双反斜杠传给 dsh（本地盘符被 Windows 容错掉，UNC 路径则直接失效）。
 * 这里按 MSVCRT 规则实现：内嵌 `"` → `\"`；紧邻引号/结尾的连续 `\` 加倍。
 *
 * 已知限制：`%` 在 cmd.exe 中即使位于双引号内也会展开变量，本函数**无法**转义。
 * 因此 `%` 由 assertSafeArg() 直接拒绝（见下），而不是在这里假装处理。
 */
export function quoteArg(s) {
  const str = String(s);
  if (process.platform !== 'win32') return "'" + str.replace(/'/g, "'\\''") + "'";
  return quoteArgWin(str);
}

/**
 * 校验单个参数能否安全放进 `shell: true` 的命令行。
 *
 * 为什么必须拒绝而不是尽力转义：命令串最终交给 cmd.exe / sh 解释，以下字符无法安全传递——
 * - 控制字符（含 `\r` `\n`）：会截断/篡改命令，等价于注入；
 * - `%`（仅 Windows）：cmd.exe **即使在其外层有双引号也照样展开 `%VAR%`**，没有可靠的转义写法。
 *
 * 拒绝比静默传错好：`--patch` 路径被改写可能让守卫禁用**错误的**插件。
 * @throws {Error} 参数不安全时抛出（调用方应作为配置错误上报，而非继续执行）
 */
export function assertSafeArg(a) {
  const s = String(a);
  const ctrl = s.match(/[\u0000-\u001f\u007f]/);
  if (ctrl) {
    throw new Error('参数含控制字符 ' + JSON.stringify(ctrl[0]) + '，拒绝执行（会截断或篡改 shell 命令）：' + JSON.stringify(s));
  }
  if (process.platform === 'win32' && s.includes('%')) {
    throw new Error('参数含 %，cmd.exe 即使加双引号也会展开 %VAR%，无法安全转义，拒绝执行：' + JSON.stringify(s) + '（请改用不含 % 的路径）');
  }
  return s;
}

/**
 * 把命令 + 参数拼成经校验与平台转义的命令行（供 `shell: true` 使用）。
 * shell:true 下直接传 args 数组既不转义又会触发 DEP0190，所以统一走这里。
 * bin 同样转义——dsh 可能装在含空格的路径下（如 C:\Program Files\...）。
 */
export function buildCommandLine(bin, args) {
  return [quoteArg(assertSafeArg(bin)), ...args.map(a => quoteArg(assertSafeArg(a)))].join(' ');
}

/** cmd.exe / MSVCRT 规则的 Windows 参数转义（独立导出以便在任何平台单测）。 */
export function quoteArgWin(s) {
  const str = String(s);
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') {
      let n = 0;
      while (str[i] === '\\') { n++; i++; }
      i--; // 回退到最后一个反斜杠
      const next = str[i + 1];
      out += '\\'.repeat(next === '"' || next === undefined ? n * 2 : n);
    } else if (ch === '"') {
      out += '\\"';
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/**
 * 运行 dsh 子命令。返回 { code, stdout, stderr, timedOut, quit, error }。
 * quitAfterMs + quitMeansOk：测试钩子，超时后杀掉子进程并按正常结束处理。
 */
export function runDsh(bin, args, { env = process.env, timeoutMs = 120000, quitAfterMs = 0, cwd } = {}) {
  return new Promise((resolve) => {
    // buildCommandLine 会做参数安全校验并抛错；在 Promise 内抛出会变成 rejection，故先同步算好
    let cmd;
    try { cmd = buildCommandLine(bin, args); } catch (e) { resolve({ code: null, stdout: '', stderr: '', timedOut: false, quit: false, error: e?.message ?? String(e) }); return; }
    const child = spawn(cmd, {
      shell: true,
      windowsHide: true,
      cwd,
      env: { ...process.env, ...env },
      // P1：POSIX 下必须建新进程组，否则 killTree 的 process.kill(-pid) 必然失败、
      // 退化成只杀 shell，留下孤儿 dsh（占端口/资源）。Windows 用 taskkill /T 不受影响。
      detached: process.platform !== 'win32'
    });
    let stdout = '', stderr = '', done = false;
    let timer = null;
    let quitTimer = null;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(quitTimer); resolve(res); };
    child.stdout?.on('data', d => stdout += d);
    child.stderr?.on('data', d => stderr += d);
    child.on('error', e => { killTree(child); finish({ code: null, stdout, stderr, timedOut: false, quit: false, error: e.message }); });
    child.on('close', (code) => { if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; } finish({ code, stdout, stderr, timedOut: false, quit: false }); });
    if (timeoutMs > 0) timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, stdout, stderr, timedOut: true, quit: false });
    }, timeoutMs);
    if (quitAfterMs > 0) quitTimer = setTimeout(() => {
      killTree(child);
      finish({ code: null, stdout, stderr, timedOut: false, quit: true });
    }, quitAfterMs);
  });
}

/** 通过 `dsh --profile <p> --dump-config` 获得组合后的行清单。 */
export async function composeRows(profile, patchFiles = [], { dshBin = "dsh", env = process.env } = {}) {
  const args = ['--profile', profile, '--dump-config'];
  for (const p of patchFiles) args.push('--patch', p);
  const res = await runDsh(dshBin, args, { env, timeoutMs: 90000 });
  if (res.code !== 0) {
    throw new Error('dump-config 失败（exit ' + res.code + '）：' + (res.stderr || res.stdout || res.error || 'unknown').slice(0, 800));
  }
  const { parsePatchYaml } = await import('./yaml.mjs');
  const parsed = await parsePatchYaml(res.stdout);
  const rows = Array.isArray(parsed) ? parsed.filter(r => r && typeof r === "object") : [];
  return { rows, raw: res.stdout, warnings: (res.stderr || "").split(/\r?\n/).filter(l => l.includes("patch:")) };
}
