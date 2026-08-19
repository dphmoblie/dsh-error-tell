// runtime-guard：宿主运行时看门狗。落盘逻辑统一复用 @dsh-error-tell/core（L4）。
import { countManaged, recordFailure, readManaged, syncDisable, writeManaged } from '@dsh-error-tell/core';
import { join } from 'node:path';
import { homedir } from 'node:os';

export { countManaged, recordFailure, syncDisable } from '@dsh-error-tell/core'; // 单测兼容导出

export const name = 'error-tell-runtime';
export const inject = [];

const SELF = 'error-tell-runtime';
const FIBER_FAILED = 3;

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const patchPath = join(home, 'cordis.patch.yml');
  const maxDisable = Number(process.env.DSH_ERROR_TELL_MAX_DISABLE || 5);
  const seen = new Set();

  const record = (rowId, pkg, stage, error) => {
    if (seen.has(rowId) || rowId === SELF) return;
    seen.add(rowId);
    try {
      const disabled = recordFailure(home, patchPath, { rowId, pkg, stage, error, source: 'runtime-guard', maxDisable, log: (m) => ctx.logger?.error?.(m) });
      ctx.logger?.error?.(disabled
        ? '[dsh-error-tell] 已禁用问题插件 ' + rowId + '（' + stage + '），重启后生效'
        : '[dsh-error-tell] 已记录 ' + rowId + '（' + stage + '），但未写入 managed 禁用');
    } catch (e) {
      ctx.logger?.error?.('[dsh-error-tell] 落盘失败: ' + (e?.message ?? e));
    }
  };

  // 1) 激活失败：fiber → FAILED
  ctx.on('internal/status', (fiber, oldState) => {
    if (!fiber || fiber.state !== FIBER_FAILED) return;
    const entry = fiber.entry;
    const rowId = entry?.options?.id ?? fiber.name;
    if (rowId === SELF) return;
    record(rowId, fiber.name, 'apply', fiber._error ?? 'plugin apply failed');
  });

  // 2) import 失败：entry-init 后监听 _initTask 拒绝（含已在途的条目）
  const watch = (entry) => {
    const rowId = entry?.options?.id;
    if (!rowId || rowId === SELF || entry.disabled) return;
    const task = entry._initTask;
    if (task && typeof task.then === 'function') {
      task.catch((err) => record(rowId, entry.options.name, 'import', err?.message ?? err));
    }
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

  ctx.logger?.info?.('[dsh-error-tell] runtime guard active (home=%s)', home);
  return () => { /* 常驻 */ };
}
