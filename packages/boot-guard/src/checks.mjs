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

/** 限流并发执行（保持调用方拿到全部结果，不保证完成顺序）。 */
async function mapLimit(items, limit, fn) {
  const width = Math.min(Math.max(1, Number(limit) || 1), items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  }));
}

/**
 * import 干跑结果缓存：同一包名（相同 profileDir/dshInstall）只跑一次。
 * 注意这是进程级缓存，长驻进程应在每次守护开始前 clearImportCache()，避免结果发霉。
 */
const importCache = new Map();

/** 清空 import 干跑缓存（长驻进程/测试用）。 */
export function clearImportCache() {
  importCache.clear();
}

/**
 * 对行清单做静态检查 + import 干跑。
 *
 * 性能（M8）：import 干跑是子进程，单个包的耗时 ≈ 启动 + 真实加载，坏包还要等满 timeout。
 * 原实现逐行串行 await，N 个包的最坏耗时是 Σtimeout；这里改为「唯一包并行、限流 concurrency」，
 * 最坏耗时降到 ≈ ⌈N/concurrency⌉ × timeout，同时用 plan 回放保证 issues 顺序与串行实现一致。
 *
 * @returns issues: { severity: "error"|"warn"|"info", stage, rowId, package?, message }
 */
export async function runChecks(rows, {
  profileDir, dshInstall, timeoutMs = 20000, skipPackages = [],
  importChecks = true, concurrency = 4, runner = checkImport
} = {}) {
  const seen = new Set();
  const cwds = [profileDir, dshInstall].filter(Boolean);
  const plan = [];        // 按原行顺序记录「该行产出什么」
  const pendingKeys = []; // 唯一 cacheKey（首次出现顺序）
  const jobs = new Map(); // cacheKey -> 惰性启动函数（必须惰性，否则限流失效）

  // 第一阶段：静态检查（同步），并把需要 import 干跑的行登记进 plan
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !row.id) {
      plan.push({ type: 'issue', issue: { severity: 'warn', stage: 'config', rowId: String(row?.id ?? '?'), message: '行缺少 id（配置问题，跳过禁用路径）' } });
      continue;
    }
    if (seen.has(row.id)) plan.push({ type: 'issue', issue: { severity: 'error', stage: 'config', rowId: row.id, message: '重复的行 id' } });
    seen.add(row.id);
    if (row.disabled) continue;
    if (!row.name) {
      plan.push({ type: 'issue', issue: { severity: 'error', stage: 'config', rowId: row.id, message: '启用的行缺少 name' } });
      continue;
    }
    if (skipPackages.includes(row.name) || !importChecks) continue;
    const probe = probePackage(row.name, { profileDir, dshInstall });
    if (probe?.clientOnly) {
      plan.push({ type: 'issue', issue: { severity: 'info', stage: 'probe', rowId: row.id, message: 'client-only 包 ' + row.name + '，跳过 import 干跑（浏览器侧，见 client-tell）' } });
      continue;
    }
    const cacheKey = row.name + '@' + (profileDir || '') + '@' + (dshInstall || '');
    plan.push({ type: 'import', cacheKey, name: row.name, rowId: row.id });
    if (!jobs.has(cacheKey)) {
      pendingKeys.push(cacheKey);
      const hit = importCache.get(cacheKey);
      jobs.set(cacheKey, hit
        ? async () => hit
        : async () => {
          try {
            const res = await runner(row.name, cwds, timeoutMs);
            importCache.set(cacheKey, res);
            return res;
          } catch (e) {
            const res = { ok: false, stage: 'spawn', error: String(e?.message ?? e) };
            importCache.set(cacheKey, res);
            return res;
          }
        });
    }
  }

  // 第二阶段：唯一包并行干跑（限流）。jobs 是惰性的，因此同一时刻最多 concurrency 个子进程
  const resolved = new Map();
  await mapLimit(pendingKeys, concurrency, async (k) => { resolved.set(k, await jobs.get(k)()); });

  // 第三阶段：按原行顺序回放，产出与串行实现一致的 issues 顺序
  const issues = [];
  for (const step of plan) {
    if (step.type === 'issue') { issues.push(step.issue); continue; }
    const r = resolved.get(step.cacheKey);
    if (r && !r.ok) issues.push({ severity: 'error', stage: r.stage, rowId: step.rowId, package: step.name, message: r.error });
  }
  return issues;
}
