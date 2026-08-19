import { spawn } from 'node:child_process';

export function quoteArg(s) {
  return '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"';
}

/**
 * 运行 dsh 子命令。返回 { code, stdout, stderr, timedOut, quit, error }。
 * quitAfterMs + quitMeansOk：测试钩子，超时后杀掉子进程并按正常结束处理。
 */
export function runDsh(bin, args, { env = process.env, timeoutMs = 120000, quitAfterMs = 0, cwd } = {}) {
  return new Promise((resolve) => {
    const cmd = [bin, ...args.map(quoteArg)].join(' ');
    const child = spawn(cmd, { shell: true, windowsHide: true, cwd, env: { ...process.env, ...env } });
    let stdout = '', stderr = '', done = false;
    let timer = null;
    let quitTimer = null;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(quitTimer); resolve(res); };
    child.stdout?.on('data', d => stdout += d);
    child.stderr?.on('data', d => stderr += d);
    child.on('error', e => finish({ code: null, stdout, stderr, timedOut: false, quit: false, error: e.message }));
    child.on('close', (code) => { if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; } finish({ code, stdout, stderr, timedOut: false, quit: false }); });
    if (timeoutMs > 0) timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, timedOut: true, quit: false });
    }, timeoutMs);
    if (quitAfterMs > 0) quitTimer = setTimeout(() => {
      child.kill();
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
