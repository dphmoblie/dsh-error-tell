import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from './compose.mjs';

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 包是否提供 host（非纯浏览器）入口。
 * P2-15：原实现只认 `main`/`module`/`exports["."]`，会把 `exports: "./index.js"`、
 * 条件导出直接写在顶层等合法写法误判成「没有 host 入口」→ 进而误判为 client-only 而跳过干跑。
 */
export function hasHostEntry(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  if (pkg.main || pkg.module) return true;
  const ex = pkg.exports;
  if (typeof ex === 'string') return true;        // exports: "./index.js"
  if (Array.isArray(ex)) return ex.length > 0;    // exports: ["./a.js"]
  if (ex && typeof ex === 'object') {
    if (Object.prototype.hasOwnProperty.call(ex, '.')) return true;
    // 条件导出直接写在顶层（没有 "." 键）
    return ['import', 'require', 'default', 'node', 'browser'].some(k => k in ex);
  }
  return false;
}

function probePackage(name, { profileDir, dshInstall }) {
  for (const base of [profileDir, dshInstall].filter(Boolean)) {
    try {
      const req = createRequire(join(base, "package.json"));
      const p = req.resolve(name + "/package.json");
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      return { path: p, pkg, clientOnly: Boolean(pkg.dsh?.client) && !hasHostEntry(pkg) };
    } catch { /* try next base */ }
  }
  return null;
}

/**
 * 目标包本身是否「解析不到」——而不是它**内部依赖**坏了。
 * P1-3：只有这种情况才允许回退到 dshInstall。否则 profile 里目标包存在、但其内部依赖缺失时，
 * 会回退到全局安装的同名健康包并被判为「导入成功」，把真正的损坏掩盖掉。
 * 判据：错误里报的正是目标包名（`Cannot find package '<name>'`）；若报的是别的包名，
 * 说明是目标包内部的传递依赖缺失，必须如实上报。
 */
export function isTargetUnresolved(msg, name) {
  const s = String(msg || '');
  return resolutionNames(name).some((cand) => {
    const n = escapeRe(cand);
    // 关键：一律要求目标包名出现在**引号内**（Node 只把「缺失的说明符」放进引号，
    // 而 `imported from <路径>` 里的路径永远不加引号）。
    // 原第三条写成 `ERR_MODULE_NOT_FOUND[^\n]*<name>`，在 Linux/macOS 上必然误判：
    //   真实报错 = Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'lodash'
    //              imported from /tmp/x/node_modules/@x/target/index.js
    //   路径里带着目标包名 → 被判成「目标包解析不到」→ 回退到全局同名健康包 → 真损坏被掩盖。
    // （在 Windows 上该 bug 侥幸不触发：路径用 `\`，而正则找的是 `@x/target` 这种正斜杠写法。）
    return new RegExp("Cannot find package '" + n + "'").test(s)
      || new RegExp("Cannot find module '" + n + "'").test(s)
      || new RegExp("ERR_MODULE_NOT_FOUND[^\\n]*'" + n + "'").test(s);
  });
}

/**
 * 目标包的「解析标识符」候选：完整 spec + 带子路径时的**包根名**。
 * Node 报 `Cannot find package '<x>'` 时，引号里放的永远是**包根名**（不含子路径）：
 *   行 name = '@scope/pkg/list-agents'，包缺失时消息 = `Cannot find package '@scope/pkg'`。
 * 只比对完整 spec 就会漏判 → 不回退到 dshInstall 锚点 → 官方子路径行被误报 import 失败
 * （实例：dsh-base 的 `@deepseek-ai/dsh-tool-subagent-control/list-agents`，且它属于保护名单，
 * 记账副作用会在干净 profile 上凭空创建隔离账本）。
 * 注意这不会削弱下面的 P1-3 判据：内部传递依赖缺失时引号里是**别的**包名，两个候选都命中不了。
 */
export function resolutionNames(name) {
  const n = String(name || '');
  const seg = n.split('/');
  const root = n.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0];
  return root && root !== n ? [n, root] : [n];
}

/** 唯一哨兵序号：每次干跑一个，避免目标包自己打印 OK 造成假阳性（P2-11）。 */
let sentinelSeq = 0;

/** 导出的干跑实现（供单测直接驱动，无需经由 runChecks）。 */
export function checkImport(name, cwdList, timeoutMs) {
  return new Promise((resolve) => {
    const sentinel = '__DET_IMPORT_OK_' + process.pid + '_' + (++sentinelSeq) + '__';
    const code = "import(process.argv[1]).then(()=>{console.log(process.argv[2]);process.exit(0)},e=>{console.error((e&&e.stack)||String(e));process.exit(1)})";
    const run = (idx, retried = false) => {
      const cwd = cwdList[idx];
      if (cwd === undefined) return resolve({ ok: false, stage: "import", error: "模块无法解析（已尝试全部查找目录）" });
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, name, sentinel], {
        cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        // P2-10：建进程组，超时时才能按组杀干净（否则插件派生的孙进程会留成孤儿）
        detached: process.platform !== 'win32'
      });
      let out = '', err = '', done = false, timer = null, abandoned = false;
      const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
      timer = setTimeout(() => {
        // 预检超时多半是机器负载抖动（一次干跑要并发起 ~90 个 node 进程），
        // 而超时会被上游记成「该行失败」——对官方行是凭空写出隔离账本、对第三方行最终会误禁用。
        // 因此同一锚点重试一次；两次都超时才如实上报。被杀掉的旧进程必须标记为放弃，
        // 否则它稍后触发的 exit 事件会二次进入判定（重复 resolve 或凭空多跑一轮）。
        abandoned = true;
        killTree(child);
        if (!retried) return run(idx, true);
        finish({ ok: false, stage: "timeout", error: "import 超时(" + timeoutMs + "ms，重试 1 次后仍超时): " + name });
      }, timeoutMs);
      child.stdout.on('data', d => out += d);
      child.stderr.on('data', d => err += d);
      child.on("error", e => { if (!abandoned) finish({ ok: false, stage: "spawn", error: e.message }); });
      child.on('exit', (exitCode) => {
        if (abandoned) return;
        // P2-11：必须「见到本次的唯一哨兵」**且**「退出码为 0」才算成功。
        // 原实现只看 stdout 是否包含 "OK"，目标包先打印 OK 再抛错也会被判成功。
        const sawSentinel = out.includes(sentinel);
        const msg = (err || out || '').split('\n').slice(0, 6).join('\n');
        if (sawSentinel && exitCode === 0) return finish({ ok: true });
        // P1-3：只对「目标包本身解析不到」回退到下一个解析锚点
        if (isTargetUnresolved(msg, name) && idx + 1 < cwdList.length) return run(idx + 1);
        if (sawSentinel) return finish({ ok: false, stage: "import", error: "import 后进程以非 0 退出（exit " + exitCode + "）：" + name });
        finish({ ok: false, stage: "import", error: msg || ("import 失败: " + name) });
      });
    };
    run(0, false);
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
