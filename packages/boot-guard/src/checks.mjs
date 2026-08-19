import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function probePackage(name, { profileDir, dshInstall }) {
  for (const base of [profileDir, dshInstall].filter(Boolean)) {
    try {
      const req = createRequire(join(base, "package.json"));
      const p = req.resolve(name + "/package.json");
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      const hasHostEntry = Boolean(pkg.main || pkg.module || pkg.exports?.["."]);
      return { path: p, pkg, clientOnly: Boolean(pkg.dsh?.client) && !hasHostEntry };
    } catch { /* try next base */ }
  }
  return null;
}

function checkImport(name, cwdList, timeoutMs) {
  return new Promise((resolve) => {
    const code = "import(process.argv[1]).then(()=>{console.log('OK');process.exit(0)},e=>{console.log('FAIL');console.error((e&&e.stack)||String(e));process.exit(1)})";
    const run = (idx) => {
      const cwd = cwdList[idx];
      if (cwd === undefined) return resolve({ ok: false, stage: "import", error: "模块无法解析（已尝试全部查找目录）" });
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, name], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '', done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve({ ok: false, stage: "timeout", error: "import 超时(" + timeoutMs + "ms): " + name }); } }, timeoutMs);
      child.stdout.on('data', d => out += d);
      child.stderr.on('data', d => err += d);
      child.on("error", e => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, stage: "spawn", error: e.message }); });
      child.on('exit', (code) => {
        if (done) return; done = true; clearTimeout(timer);
        if (out.includes("OK")) return resolve({ ok: true });
        const msg = (err || out || '').split('\n').slice(0, 6).join('\n');
        if (/Cannot find|ERR_MODULE_NOT_FOUND|Cannot resolve/i.test(msg) && idx + 1 < cwdList.length) return run(idx + 1);
        resolve({ ok: false, stage: "import", error: msg || ("import 失败: " + name) });
      });
    };
    run(0);
  });
}

/**
 * 对行清单做静态检查 + import 干跑。
 * @returns issues: { severity: "error"|"warn"|"info", stage, rowId, package?, message }
 */
export async function runChecks(rows, { profileDir, dshInstall, timeoutMs = 20000, skipPackages = [], importChecks = true } = {}) {
  const issues = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !row.id) {
      issues.push({ severity: 'warn', stage: 'config', rowId: String(row?.id ?? '?'), message: '行缺少 id（配置问题，跳过禁用路径）' });
      continue;
    }
    if (seen.has(row.id)) issues.push({ severity: 'error', stage: 'config', rowId: row.id, message: '重复的行 id' });
    seen.add(row.id);
    if (row.disabled) continue;
    if (!row.name) {
      issues.push({ severity: 'error', stage: 'config', rowId: row.id, message: '启用的行缺少 name' });
      continue;
    }
    if (skipPackages.includes(row.name)) continue;
    if (!importChecks) continue;
    const probe = probePackage(row.name, { profileDir, dshInstall });
    if (probe?.clientOnly) {
      issues.push({ severity: 'info', stage: 'probe', rowId: row.id, message: 'client-only 包 ' + row.name + '，跳过 import 干跑（浏览器侧，见 client-tell）' });
      continue;
    }
    const r = await checkImport(row.name, [profileDir, dshInstall].filter(Boolean), timeoutMs);
    if (!r.ok) issues.push({ severity: 'error', stage: r.stage, rowId: row.id, package: row.name, message: r.error });
  }
  return issues;
}
