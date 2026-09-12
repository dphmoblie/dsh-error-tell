// runtime-guard：宿主运行时看门狗。落盘逻辑统一复用 @dsh-error-tell/core（L4）。
import { countManaged, recordFailure, readManaged, syncDisable, writeManaged, restoreQuarantine, batchThreshold, nonNegativeInt, isPendingLikeError, isEnvError } from '@dsh-error-tell/core';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export { countManaged, recordFailure, syncDisable, resetRunDisabled } from '@dsh-error-tell/core'; // 单测兼容导出

export const name = 'error-tell-runtime';
export const inject = [];

const SELF = 'error-tell-runtime';
const FIBER_FAILED = 3;

/**
 * dsh 的 updateError 逐层包裹错误：`failed to <stage> loader entry <id> (<name>): <cause>`。
 * 级联失败时父条目（如 include）只是受害者，**最深的一层才是真凶**。
 *
 * 为什么必须这样做（本机 dsh 0.1.5-alpha.1 实测）：
 *   profile 插件条目由 `include` 子树的 loader 创建，runtime-guard 对它们是完全盲的——
 *   实测 apply 时的 `ctx.loader.entries()` 快照 154 条里没有任何 fixture 条目，
 *   整个启动只收到 2 次 `loader/entry-init`（且都是匿名条目），
 *   包裹 `Entry.prototype._init` 也只赶得上 2 次调用（fixture 的 `_init` 在 apply 前就启动了）。
 *   而 import 失败**不会产生 fiber**，所以 `internal/status` 也没有信号。
 *   唯一稳定可用的信号，就是我们本来就能捕获的父条目拒绝里那条 cause 链。
 *
 * @returns {null | {stage: string, rowId: string, name: string}}
 */
export function culpritOf(err) {
  let deepest = null;
  let e = err;
  for (let depth = 0; e && depth < 20; depth++) {
    const m = /failed to (import|apply) loader entry (\S+) \(([^)]+)\)/.exec(String(e?.message ?? ''));
    if (m) deepest = { stage: m[1], rowId: m[2], name: m[3] };
    e = e.cause;
  }
  return deepest;
}

/** 从错误里取真实阶段（无 cause 链信息时的兜底）。 */
export function stageOf(err) {
  return /failed to import loader entry/.test(String(err?.message ?? err)) ? 'import' : 'apply';
}

/**
 * M7：dsh 私有 API 能力自检。
 * 本插件依赖 dsh 内部结构（loader.entries / entry._initTask / fiber.state），
 * 这些不是稳定契约。漂移时必须**显式告警**，而不是静默失效。
 */
export function capabilityReport(ctx) {
  const missing = [];
  const loader = ctx?.loader;
  if (!loader || typeof loader.entries !== 'function') {
    missing.push('ctx.loader.entries() 缺失');
    return { missing };
  }
  let entries = [];
  try { entries = [...loader.entries()]; } catch (e) { missing.push('loader.entries() 抛错: ' + (e?.message ?? e)); }
  const sample = entries.find(x => x && x.options && !x.options.group);
  if (sample) {
    if (!('_initTask' in sample)) missing.push('entry._initTask 缺失（已在途条目的失败无法捕获）');
    const f = sample.fiber;
    if (f && typeof f.state !== 'number') missing.push('fiber.state 不是数值（apply 失败捕获可能失效）');
  }
  return { missing };
}

/** 尽力探测 dsh 版本（仅用于告警文案，失败返回 null）。 */
function detectDshVersion() {
  for (const base of [process.cwd(), homedir()]) {
    try {
      const req = createRequire(pathToFileURL(join(base, '__dsh_error_tell_ver__.js')));
      const v = req('@deepseek-ai/dsh/package.json')?.version;
      if (v) return v;
    } catch { /* 换下一个锚点 */ }
  }
  return null;
}

/**
 * P1-5：批量熔断时只回滚**本进程写入**的禁用行。
 * 原实现遍历 seen 并删除所有位于 managed 里的 id，会把上一个进程留下的历史禁用项一并恢复。
 * 独立导出以便单测（不需要真实 dsh）。
 * @returns {string[]} 实际被回滚的 id
 */
export function rollbackWritten(home, patchPath, writtenThisRun) {
  const ids = [...writtenThisRun];
  if (!ids.length) return [];
  const managed = readManaged(patchPath);
  const rolled = [];
  for (const id of ids) {
    if (managed.ids.has(id)) {
      managed.ids.delete(id);
      restoreQuarantine(home, id);
      rolled.push(id);
    }
  }
  if (rolled.length) writeManaged(patchPath, managed.ids);
  return rolled;
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const patchPath = join(home, 'cordis.patch.yml');
  // P2-9：Number("abc") → NaN 会让熔断条件恒为 false，统一走非负整数解析
  const maxDisable = nonNegativeInt(process.env.DSH_ERROR_TELL_MAX_DISABLE, 5);
  const seen = new Set();          // 已进入处理流程的行（去重 + 批量计数）
  const writtenThisRun = new Set(); // P1-5：**本进程**真正写进 managed 的行

  let batchReverted = false;
  const record = (rowId, pkg, stage, error) => {
    if (rowId === SELF) return;
    try {
      // P2-8：pending / 环境类错误不是「有效失败」，不占用 seen。
      // 原实现先 seen.add 再交给 recordFailure 分类，导致同一插件的第一次事件若是 pending，
      // 之后的**真实失败**会被去重永久跳过。
      if (isPendingLikeError(error) || isEnvError(error)) {
        recordFailure(home, patchPath, { rowId, pkg, stage, error, source: 'runtime-guard', maxDisable, batchCount: seen.size + 1, log: (m) => ctx.logger?.error?.(m) });
        return;
      }
      if (seen.has(rowId)) return;

      // 批量失败熔断：达到阈值时撤销**本进程已写**的 managed 禁用（级联故障不误杀）
      const nextCount = seen.size + 1;
      if (nextCount >= batchThreshold() && !batchReverted) {
        batchReverted = true;
        // P1-5：原实现遍历 seen 并删除所有位于 managed 里的 id，把**历史禁用项**也一并恢复了。
        // 只回滚 writtenThisRun，绝不碰上一个进程留下的禁用。
        rollbackWritten(home, patchPath, writtenThisRun);
        ctx.logger?.error?.('[dsh-error-tell] 批量失败熔断：撤销本进程已写的 managed 禁用（疑似环境/级联问题）');
      }
      seen.add(rowId);
      const disabled = recordFailure(home, patchPath, { rowId, pkg, stage, error, source: 'runtime-guard', maxDisable, batchCount: seen.size, log: (m) => ctx.logger?.error?.(m) });
      if (disabled) writtenThisRun.add(rowId);
      ctx.logger?.error?.(disabled
        ? '[dsh-error-tell] 已禁用问题插件 ' + rowId + '（' + stage + '），重启后生效'
        : '[dsh-error-tell] 已记录 ' + rowId + '（' + stage + '），但未写入 managed 禁用');
    } catch (e) {
      ctx.logger?.error?.('[dsh-error-tell] 落盘失败: ' + (e?.message ?? e));
    }
  };

  // 观察一个「条目初始化」promise：不改动原 promise，拒绝仍照常向 loader 传播。
  // 归因优先用 cause 链里的最深层肇事条目（父条目往往只是级联受害者）。
  const observe = (p, fallbackId, fallbackName) => {
    if (!p || typeof p.then !== 'function') return;
    p.catch((err) => {
      const c = culpritOf(err);
      const msg = String(err?.message ?? err);
      if (c) record(c.rowId, c.name, c.stage, msg);
      else record(fallbackId, fallbackName, stageOf(err), msg);
    });
  };

  // 1) 激活失败：fiber → FAILED
  ctx.on('internal/status', (fiber, oldState) => {
    if (!fiber || fiber.state !== FIBER_FAILED) return;
    const entry = fiber.entry;
    const rowId = entry?.options?.id ?? fiber.name;
    if (rowId === SELF) return;
    record(rowId, fiber.name, 'apply', fiber._error ?? 'plugin apply failed');
  });

  // 2) import / apply 失败：捕获已在途条目的 _initTask 拒绝
  //    （entry-init 事件对本用例无效：它在 Entry 构造函数末尾触发，此刻 options 还是空对象 {}，
  //     rowId 拿不到；_initTask 也要到 update() 赋值 options 之后才被 init() 挂上）
  const watch = (entry) => {
    const opts = entry?.options || {};
    if (!opts.id || opts.id === SELF || opts.group) return;
    observe(entry._initTask, opts.id, opts.name);
  };
  ctx.on('loader/entry-init', watch);
  try { for (const entry of ctx.loader.entries()) watch(entry); } catch { /* loader 未就绪 */ }

  // 3) 兜底 A：apply 时扫描已在途失败（状态 FAILED）的兄弟条目
  try {
    for (const entry of ctx.loader.entries()) {
      const f = entry.fiber;
      if (f && f.state === FIBER_FAILED) record(entry.options.id, entry.options.name, "apply", f._error ?? "plugin apply failed");
    }
  } catch { /* loader 未就绪 */ }

  // 4) 兜底 B：fiber 释放事件（uid 置空）时若带 _error 也记录（覆盖 internal/status 竞态）
  ctx.on('internal/plugin', (fiber) => {
    if (fiber.uid !== null || !fiber.entry || !fiber._error) return;
    record(fiber.entry.options.id, fiber.name, 'apply', fiber._error);
  });

  // M7：能力自检——私有 API 漂移时显式告警
  const caps = capabilityReport(ctx);
  if (caps.missing.length) {
    ctx.logger?.error?.('[dsh-error-tell] dsh 能力自检未通过（dsh ' + (detectDshVersion() || '版本未知') + '）：'
      + caps.missing.join('；') + '。runtime-guard 可能无法检测部分插件失败，请检查 dsh 版本兼容性');
  }

  ctx.logger?.info?.('[dsh-error-tell] runtime guard active (home=%s)', home);
  return () => { /* 常驻 */ };
}
