import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'error-tell-runtime';
export const inject = [];

const SELF = 'error-tell-runtime';
const FIBER_FAILED = 3;
const MANAGED_START = '# --- dsh-error-tell managed (auto-generated; do not edit) ---';
const MANAGED_END = '# --- end dsh-error-tell managed ---';

/** 同步写账本（进程可能随时 fail-loud 退出，不能用异步 IO）。 */
function syncLedger(home, entry) {
  const ledgerPath = join(home, 'state', 'dsh-error-tell', 'quarantine.json');
  let ledger = { version: 1, entries: [] };
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { /* first write */ }
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  const existing = ledger.entries.find(e => e.rowId === entry.rowId && !e.restoredAt);
  if (existing) Object.assign(existing, entry);
  else ledger.entries.push({ ...entry, at: new Date().toISOString() });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath + '.tmp', JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  renameSync(ledgerPath + '.tmp', ledgerPath);
}

/** 当前 managed 段禁用行数（上限判定用）。 */
export function countManaged(patchPath) {
  let text = '';
  try { text = readFileSync(patchPath, 'utf8'); } catch { return 0; }
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  if (start < 0 || end <= start) return 0;
  let n = 0;
  for (const line of text.slice(start + MANAGED_START.length, end).split(/\r?\n/)) {
    if (/^\s*-\s*id:/.test(line)) n += 1;
  }
  return n;
}

/** 同步把 rowId 加入 managed 禁用段。 */
export function syncDisable(patchPath, rowId) {
  let text = "";
  try { text = readFileSync(patchPath, 'utf8'); } catch { /* new file */ }
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  const ids = new Set();
  if (start >= 0 && end > start) {
    for (const line of text.slice(start + MANAGED_START.length, end).split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*id:\s*([^\s]+)/);
      if (m) ids.add(m[1].replace(/['"]/g, ''));
    }
  }
  ids.add(rowId);
  const block = [MANAGED_START, ...[...ids].sort().map(id => '- id: ' + id + '\n  disabled: true'), MANAGED_END, ''].join('\n');
  let next;
  if (start >= 0 && end > start) {
    next = text.slice(0, start) + block + text.slice(end + MANAGED_END.length);
  } else {
    next = text.replace(/\s*$/, '') + '\n\n' + block;
  }
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath + '.tmp', next, 'utf8');
  renameSync(patchPath + '.tmp', patchPath);
}

/**
 * 记录一次失败并同步落盘（账本必写；managed 禁用受 maxDisable 熔断）。
 * 供 apply 与单测复用。
 */
export function recordFailure(home, patchPath, { rowId, pkg, stage, error, source = 'runtime-guard', maxDisable = 50, log = () => {} }) {
  if (!rowId) return false;
  syncLedger(home, { rowId, package: pkg, stage, error: String(error).split("\n")[0], source });
  if (countManaged(patchPath) >= maxDisable) {
    log('[dsh-error-tell] 熔断：managed 禁用数已达上限 ' + maxDisable + '，跳过禁用 ' + rowId + '（账本已记录）');
    return false;
  }
  syncDisable(patchPath, rowId);
  return true;
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const patchPath = join(home, 'cordis.patch.yml');
  const maxDisable = Number(process.env.DSH_ERROR_TELL_MAX_DISABLE || 50);
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
