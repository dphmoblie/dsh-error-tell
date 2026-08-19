// @dsh-error-tell/core：managed 补丁段读写 + 隔离账本 + 熔断记录。
// 全部为同步实现（runtime-guard 需在进程退出前完成落盘）。
// 唯一权威实现：boot-guard 的 patch-writer/quarantine 与本包的落盘函数均由此提供。
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export const MANAGED_START = '# --- dsh-error-tell managed (auto-generated; do not edit) ---';
export const MANAGED_END = '# --- end dsh-error-tell managed ---';

export function dshHome(env = process.env) {
  return resolve(env.DSH_HOME || join(homedir(), '.dsh'));
}
export function homePatchPath(home) {
  return join(home, 'cordis.patch.yml');
}
export function stateDir(home) {
  return join(home, 'state', 'dsh-error-tell');
}
export function quarantinePath(home) {
  return join(stateDir(home), 'quarantine.json');
}


/** 读取 managed 段：返回 { text, ids:Set, present }。 */
export function readManaged(patchPath) {
  let text = "";
  try { text = readFileSync(patchPath, "utf8"); } catch { return { text: "", ids: new Set(), present: false }; }
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  if (start >= 0 && end > start) {
    const ids = new Set();
    for (const line of text.slice(start + MANAGED_START.length, end).split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*id:\s*([^\s]+)/);
      if (m) ids.add(m[1].replace(/['"]/g, ""));
    }
    return { text, ids, present: true };
  }
  return { text, ids: new Set(), present: false };
}

export function renderBlock(ids) {
  const lines = [MANAGED_START];
  for (const id of [...ids].sort()) lines.push('- id: ' + id, '  disabled: true');
  lines.push(MANAGED_END, "");
  return lines.join('\n');
}

/** 幂等地把 managed 段改写为给定 id 集合（保留段外内容与注释）。 */
export function writeManaged(patchPath, ids) {
  ids = ids instanceof Set ? ids : new Set(ids);
  const { text, present } = readManaged(patchPath);
  if (!present && text === '' && ids.size === 0) return { ids: [] }; // 无事不创建文件（空 YAML 会破坏 parsePatchList）
  if (present && ids.size === 0) {
    // 空集：移除 managed 段；若文件只剩该段则整体删除（注释-only 文件会被 dsh 的 parsePatchList 拒绝）
    const start = text.indexOf(MANAGED_START);
    const end = text.indexOf(MANAGED_END);
    const rest = (text.slice(0, start) + text.slice(end + MANAGED_END.length)).replace(/\s+$/, '');
    if (rest.trim() === '') {
      try { unlinkSync(patchPath); } catch { /* 已不存在 */ }
      return { ids: [] };
    }
    writeFileSync(patchPath + '.tmp', rest + "\n", 'utf8');
    renameSync(patchPath + '.tmp', patchPath);
    return { ids: [] };
  }

  const block = renderBlock(ids);
  let next;
  if (present) {
    const start = text.indexOf(MANAGED_START);
    const end = text.indexOf(MANAGED_END);
    next = text.slice(0, start) + block + text.slice(end + MANAGED_END.length);
  } else {
    next = text.replace(/\s*$/, '') + '\n\n' + block;
  }
  writeFileSync(patchPath + '.tmp', next, 'utf8');
  renameSync(patchPath + '.tmp', patchPath);
  return { ids: [...ids] };
}


export function emptyLedger() {
  return { version: 1, entries: [] };
}

export function loadLedger(home) {
  try {
    const d = JSON.parse(readFileSync(quarantinePath(home), "utf8"));
    if (d && Array.isArray(d.entries)) return d;
  } catch { /* first run */ }
  return emptyLedger();
}

export function saveLedger(home, ledger) {
  const p = quarantinePath(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

export function addQuarantine(home, entry) {
  const ledger = loadLedger(home);
  const existing = ledger.entries.find(e => e.rowId === entry.rowId && !e.restoredAt);
  if (existing) {
    // 同一活动条目：累计连续失败次数（S2：连续 2 次失败才真正禁用）
    const failCount = (existing.failCount ?? 1) + 1;
    Object.assign(existing, entry, { at: existing.at, failCount });
  } else {
    ledger.entries.push({ ...entry, at: entry.at ?? new Date().toISOString(), failCount: 1 });
  }
  saveLedger(home, ledger);
  return ledger;
}

/** 某行当前活动条目的累计失败次数（无活动条目时为 0）。 */
export function failureCount(home, rowId) {
  const e = loadLedger(home).entries.find(x => x.rowId === rowId && !x.restoredAt);
  return e?.failCount ?? 0;
}

export function restoreQuarantine(home, rowId) {
  const ledger = loadLedger(home);
  let hit = false;
  for (const e of ledger.entries) {
    if (e.rowId === rowId && !e.restoredAt) { e.restoredAt = new Date().toISOString(); hit = true; }
  }
  if (hit) saveLedger(home, ledger);
  return hit;
}

export function activeQuarantine(home) {
  return loadLedger(home).entries.filter(e => !e.restoredAt);
}


/** 当前 managed 段禁用行数（上限判定用）。 */
export function countManaged(patchPath) {
  return readManaged(patchPath).ids.size;
}

/** 同步把 rowId 加入 managed 禁用段（幂等）。 */
export function syncDisable(patchPath, rowId) {
  const managed = readManaged(patchPath);
  managed.ids.add(rowId);
  writeManaged(patchPath, managed.ids);
}

/**
 * 记录一次失败：账本必写（可审计）；managed 禁用数达到 maxDisable 时熔断（跳过写 managed，返回 false）。
 */
export function recordFailure(home, patchPath, { rowId, pkg, stage, error, source = 'runtime-guard', maxDisable = 50, log = () => {} }) {
  if (!rowId) return false;
  if (countManaged(patchPath) >= maxDisable) {
    log('[dsh-error-tell] 熔断：managed 禁用数已达上限 ' + maxDisable + '，拒绝禁用 ' + rowId + '（账本已记录）');
    addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0] + '（熔断未禁用）', source: source + '-fuse' });
    return false;
  }
  addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0], source });
  syncDisable(patchPath, rowId);
  return true;
}
