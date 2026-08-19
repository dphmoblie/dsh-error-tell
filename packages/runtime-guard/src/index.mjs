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

/** 同步把 rowId 加入 managed 禁用段。 */
function syncDisable(patchPath, rowId) {
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

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const patchPath = join(home, 'cordis.patch.yml');
  const seen = new Set();

  const record = (rowId, pkg, stage, error) => {
    if (seen.has(rowId) || rowId === SELF) return;
    seen.add(rowId);
    try {
      syncLedger(home, { rowId, package: pkg, stage, error: String(error).split("\n")[0], source: "runtime-guard" });
      syncDisable(patchPath, rowId);
      ctx.logger?.error?.('[dsh-error-tell] 已禁用问题插件 ' + rowId + '（' + stage + '），重启后生效');
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

  ctx.logger?.info?.('[dsh-error-tell] runtime guard active (home=%s)', home);
  return () => { /* 常驻 */ };
}
