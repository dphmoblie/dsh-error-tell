// @dsh-error-tell/core：managed 补丁段读写 + 隔离账本 + 熔断记录。
// 全部为同步实现（runtime-guard 需在进程退出前完成落盘）。
// 唯一权威实现：boot-guard 的 patch-writer/quarantine 与本包的落盘函数均由此提供。
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml');

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
/**
 * 幂等地把 managed 段改写为给定 id 集合。
 * 事故修复（2026-08）：必须是「追加进现有顶层 YAML 数组」的补丁，而不是拼出第二个文档。
 * 流程：解析现有文件（失败即拒绝写入，绝不覆盖损坏配置）→ 与 managed 条目合并进同一数组
 * → 写盘 → 重新解析验证（失败回滚并抛错）。
 */
export function writeManaged(patchPath, ids) {
  ids = ids instanceof Set ? ids : new Set(ids);
  const { text, present } = readManaged(patchPath);
  if (!present && text === '' && ids.size === 0) return { ids: [] }; // 无事不创建文件
  if (present && ids.size === 0) {
    // 空集：移除 managed 段；若文件只剩该段则整体删除
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
    // 已有 managed 段：原位替换（段前后内容原样保留）
    const start = text.indexOf(MANAGED_START);
    const end = text.indexOf(MANAGED_END);
    next = text.slice(0, start) + block + text.slice(end + MANAGED_END.length);
  } else {
    // 无 managed 段：解析现有文档，把 managed 条目合并进同一个顶层数组
    let parsed;
    try { parsed = yaml.load(text); } catch (e) {
      throw new Error('writeManaged 拒绝写入：现有 patch 无法解析（' + patchPath + '）：' + (e && e.message || e) + '。已保留原文件，请人工修复');
    }
    if (parsed !== undefined && parsed !== null && !Array.isArray(parsed)) {
      throw new Error('writeManaged 拒绝写入：' + patchPath + ' 顶层不是 YAML 数组，无法安全合并 managed 条目。已保留原文件');
    }
    const hasItems = Array.isArray(parsed) && parsed.length > 0;
    if (!hasItems) {
      // 空数组（[]）或纯注释：整个文件替换为 managed 块（单一顶层数组）
      next = block;
    } else {
      // 有用户条目：在第一个顶层列表项之前插入 managed 块（保持单一数组 + 保留注释）
      const idx = text.indexOf('\n- ');
      const insertAt = idx === -1 ? (text.trimStart().startsWith('- ') ? 0 : text.length) : idx + 1;
      next = text.slice(0, insertAt) + block + '\n' + text.slice(insertAt);
    }
  }
  // 写盘 + 验证：写后必须仍是合法顶层数组，否则回滚
  const backup = text;
  writeFileSync(patchPath + '.tmp', next, 'utf8');
  try {
    const check = yaml.load(next);
    if (!Array.isArray(check)) throw new Error('写入结果不是顶层数组');
  } catch (e) {
    try { writeFileSync(patchPath, backup, 'utf8'); } catch { /* 尽力回滚 */ }
    throw new Error('writeManaged 写入校验失败，已回滚（' + patchPath + '）：' + (e && e.message || e));
  }
  renameSync(patchPath + '.tmp', patchPath);
  return { ids: [...ids] };
}

/** 校验 patch 文件可解析为顶层数组（写前自检用）；文件不存在视为合法。 */
export function assertPatchParseable(patchPath) {
  let text;
  try { text = readFileSync(patchPath, 'utf8'); } catch { return; }
  let parsed;
  try { parsed = yaml.load(text); } catch (e) {
    throw new Error('home patch 无法解析（' + patchPath + '）：' + (e && e.message || e) + '。拒绝任何 managed 写入，请人工修复');
  }
  if (parsed !== undefined && parsed !== null && !Array.isArray(parsed)) {
    throw new Error('home patch 顶层不是数组（' + patchPath + '）。拒绝任何 managed 写入，请人工修复');
  }
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
 * 核心服务保护名单：这些行是 dsh 的基础服务插件，自动禁用会导致级联崩溃（2026-08 事故）。
 * 命中保护名单的失败只记账 + 报警，绝不写入 managed 禁用。
 * 紧急/测试可用环境变量 DSH_ERROR_TELL_ALLOW_PROTECTED=1 绕过。
 */
export const PROTECTED_IDS = new Set([
  'include', 'timer', 'loader', 'modules', 'typert', 'typert-registry', 'typert-loader', 'typert-gateway',
  'api-gateway', 'connection', 'api-remotes', 'client-runtime', 'session', 'agent', 'agent-default-model',
  'goal', 'command-goal', 'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process',
  'subagent-control', 'subagent-report', 'workspace', 'permission', 'approval', 'settings', 'credentials',
  'storage', 'storage-json', 'storage-domain', 'webserver', 'web-runtime', 'web-startup', 'jobs',
  'llm', 'llm-retry', 'sandbox', 'sandbox-policy', 'bash-sandbox', 'pwsh-sandbox', 'shell-env',
  'agent-presets', 'system-prompt', 'fs-observation-policy', 'session-title', 'session-title-llm',
  'message-feedback', 'token-meter', 'session-projection', 'session-persistence-jsonl', 'attachment-local',
  'session-query-sqlite', 'session-telemetry-otel', 'subprocess', 'code-runtime', 'client-hmr', 'locale',
  'ui-layout', 'plugin-inventory', 'cordis-host-runner', 'cordis-client-runner', 'session-stats',
  'session-log-download', 'directory-picker', 'session-projection-cache', 'output-retention', 'compaction-basic'
]);

/** 是否受保护：命中名单，或属于 dsh 基础服务包。 */
export function isProtected(rowId, pkgName) {
  if (PROTECTED_IDS.has(rowId)) return true;
  if (pkgName && /^@deepseek-ai\/(dsh-(base|web-app|client-runtime|client-connection|client-modules|api-remotes|host-apiproxy|host-webserver|session|agent|goal|subagent|workspace|settings|credentials|storage|sandbox|permission|approval|llm|jobs|terminal|code-runtime|client-hmr|web-app|web-frontend|typert|user-questions|attachment|compaction|spill|output-retention|scope|persona))$/.test(pkgName)) return true;
  return false;
}

/** pending 类错误（依赖未满足，不是插件自身失败）不归因不禁用。 */
export function isPendingLikeError(message) {
  return /pending|waiting for service|did not activate/i.test(String(message || ''));
}
/**
 * 记录一次失败：账本必写（可审计）；managed 禁用数达到 maxDisable 时熔断（跳过写 managed，返回 false）。
 */
export function recordFailure(home, patchPath, { rowId, pkg, stage, error, source = 'runtime-guard', maxDisable = 5, log = () => {} }) {
  if (!rowId) return false;
  if (isPendingLikeError(error)) return false; // pending 不是插件失败，不归因
  const allowProtected = process.env.DSH_ERROR_TELL_ALLOW_PROTECTED === '1';
  if (!allowProtected && isProtected(rowId, pkg)) {
    log('[dsh-error-tell] 保护名单：拒绝自动禁用核心服务 ' + rowId + '（只记账，请人工确认）');
    addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0] + '（保护名单未禁用）', source: source + '-protected' });
    return false;
  }
  if (countManaged(patchPath) >= maxDisable) {
    log('[dsh-error-tell] 熔断：managed 禁用数已达上限 ' + maxDisable + '，拒绝禁用 ' + rowId + '（账本已记录）');
    addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0] + '（熔断未禁用）', source: source + '-fuse' });
    return false;
  }
  addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0], source });
  syncDisable(patchPath, rowId);
  return true;
}
