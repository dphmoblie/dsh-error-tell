import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { quarantinePath } from './home.mjs';

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
