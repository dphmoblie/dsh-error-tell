// @dsh-error-tell/core：managed 补丁段读写 + 隔离账本 + 熔断记录。
// 全部为同步实现（runtime-guard 需在进程退出前完成落盘）。
// 唯一权威实现：boot-guard 的 patch-writer/quarantine 与本包的落盘函数均由此提供。
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml');

/**
 * 原子写：写入「带随机后缀」的临时文件再 rename 覆盖目标。
 *
 * 为什么不能再用固定的 `<file>.tmp`：并发写者会写到同一个临时文件上互相覆盖，
 * 后 rename 的那个可能把别人写了一半的内容搬成正式文件，或 rename 到已被搬走的路径而 ENOENT。
 * 随机后缀让每个写者独占自己的临时文件，rename 本身在同一文件系统上是原子的。
 */
function atomicWrite(file, content) {
  const tmp = file + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 清理尽力而为 */ }
    throw e;
  }
}

/** 同步睡眠（不引入依赖）：only used for lock spin. */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

/**
 * 跨进程互斥：用 mkdir 的原子性做锁（Windows/POSIX 都成立，无需依赖）。
 * 覆盖「读 → 改 → 写」整段，避免并发写者丢失更新（P1-4）。
 * 超时后强拆陈旧锁，避免上一个进程崩溃导致永久死锁。
 */
export function withFileLock(lockPath, fn, { timeoutMs = 5000, staleMs = 10000 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true }); // 锁目录本身可能还不存在（全新 DSH_HOME）
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try { mkdirSync(lockPath); held = true; break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁：持有者可能已崩溃
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) rmdirSync(lockPath);
      } catch { /* 锁刚被释放 */ }
      if (Date.now() > deadline) throw new Error('获取文件锁超时（' + lockPath + '）');
      sleepSync(5);
    }
  }
  try { return fn(); }
  finally { if (held) { try { rmdirSync(lockPath); } catch { /* 已释放 */ } } }
}

/** 非负整数解析：非法值（NaN / 负数 / 小数 / 空串）返回 fallback，避免熔断条件被 NaN 击穿。 */
export function nonNegativeInt(value, fallback) {
  if (value === null || value === undefined) return fallback;
  // 注意 Number('') === 0（不是 NaN），空串必须显式判掉，否则会被当成合法的 0
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}


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
  // P1-4：整个「读 → 改 → 写」必须在跨进程锁内，否则并发写者会丢失更新
  return withFileLock(patchPath + '.lock', () => writeManagedLocked(patchPath, ids));
}

function writeManagedLocked(patchPath, ids) {
  ids = ids instanceof Set ? ids : new Set(ids);
  mkdirSync(dirname(patchPath), { recursive: true }); // P1-6：全新 DSH_HOME 时父目录还不存在
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
    atomicWrite(patchPath, rest + "\n");
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
  // 先验证再落盘：写入结果必须仍是合法顶层数组（校验失败则原文件分毫未动）
  try {
    const check = yaml.load(next);
    if (!Array.isArray(check)) throw new Error('写入结果不是顶层数组');
  } catch (e) {
    throw new Error('writeManaged 写入校验失败，已放弃写入（' + patchPath + '）：' + (e && e.message || e));
  }
  atomicWrite(patchPath, next);
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

/** 最近一次发现的损坏账本备份路径（供调用方/测试查询）。 */
let lastCorruptBackup = null;
export function lastCorruptLedgerBackup() { return lastCorruptBackup; }

/**
 * 读取隔离账本。
 * P1-7：只有「文件不存在」才返回空账本；JSON 损坏时先**备份**再返回空账本，
 * 绝不静默丢弃既有失败次数与审计记录（否则后续写入会直接覆盖掉唯一副本）。
 * 注意：这里选择「备份后继续」而不是「拒绝写入」——账本是状态文件而非用户配置，
 * 一个损坏的状态文件不应该让守卫彻底失效；原数据已完整保留在备份里。
 */
export function loadLedger(home) {
  const p = quarantinePath(home);
  let text;
  try { text = readFileSync(p, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return emptyLedger(); // 首次运行
    throw e;                                       // EACCES 等其它 IO 错误不吞
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed && Array.isArray(parsed.entries)) return parsed;
  const backup = p + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
  try { copyFileSync(p, backup); lastCorruptBackup = backup; } catch { /* 备份失败也要继续 */ }
  try { process.emitWarning('[dsh-error-tell] 隔离账本损坏，已备份到 ' + backup + ' 并重置为空白（原数据保留）'); } catch { /* 忽略 */ }
  return emptyLedger();
}

export function saveLedger(home, ledger) {
  const p = quarantinePath(home);
  mkdirSync(dirname(p), { recursive: true });
  atomicWrite(p, JSON.stringify(ledger, null, 2) + "\n");
}

function ledgerLock(home) { return quarantinePath(home) + '.lock'; }

export function addQuarantine(home, entry) {
  // P1-4：读→改→写必须整体互斥，否则并发写者丢失更新
  return withFileLock(ledgerLock(home), () => {
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
  });
}

/** 某行当前活动条目的累计失败次数（无活动条目时为 0）。 */
export function failureCount(home, rowId) {
  const e = loadLedger(home).entries.find(x => x.rowId === rowId && !x.restoredAt);
  return e?.failCount ?? 0;
}

export function restoreQuarantine(home, rowId) {
  return withFileLock(ledgerLock(home), () => {
    const ledger = loadLedger(home);
    let hit = false;
    for (const e of ledger.entries) {
      if (e.rowId === rowId && !e.restoredAt) { e.restoredAt = new Date().toISOString(); hit = true; }
    }
    if (hit) saveLedger(home, ledger);
    return hit;
  });
}

export function activeQuarantine(home) {
  return loadLedger(home).entries.filter(e => !e.restoredAt);
}


/** 当前 managed 段禁用行数（上限判定用）。 */
export function countManaged(patchPath) {
  return readManaged(patchPath).ids.size;
}

/**
 * 本次进程自动禁用的行（patchPath → Set<rowId>）。
 *
 * 熔断必须按「本次运行新增禁用了多少行」计数，而不是 managed 段的历史总量：
 * 后者会让已存在 maxDisable 个合法禁用行的用户永久自锁——此后任何新坏插件
 * 都无法被自动禁用，守护形同失效（S3）。boot-guard 的 assertDisableLimit
 * 本来就是按本次增量判定，这里与它对齐。
 */
const runDisabled = new Map();
function runDisabledFor(patchPath) {
  let s = runDisabled.get(patchPath);
  if (!s) { s = new Set(); runDisabled.set(patchPath, s); }
  return s;
}

/** 重置本次运行的禁用计数（测试用；不传参数则全部重置）。 */
export function resetRunDisabled(patchPath) {
  if (patchPath === undefined) runDisabled.clear();
  else runDisabled.delete(patchPath);
}

/**
 * 行 ID 白名单：只允许 DSH 行 id 实际会出现的字符（包名/子行 id 形态），限长 200。
 * P2-17：id 会直接参与 YAML 生成（`- id: <id>`）、正则构造与 HTTP 错误响应，
 * 不校验的话特殊字符可以破坏 YAML 结构、污染日志或泄露内部信息。
 */
const ROW_ID_RE = /^[A-Za-z0-9@._:/-]{1,200}$/;
export function isValidRowId(id) {
  return typeof id === 'string' && ROW_ID_RE.test(id);
}
export function assertValidRowId(id) {
  if (!isValidRowId(id)) {
    throw new Error('非法的行 id（仅允许 [A-Za-z0-9@._:/-]，长度 1..200）：' + JSON.stringify(String(id).slice(0, 80)));
  }
  return id;
}

/** 同步把 rowId 加入 managed 禁用段（幂等）。P1-4：读→改→写整体持锁。 */
export function syncDisable(patchPath, rowId) {
  assertValidRowId(rowId);
  return withFileLock(patchPath + '.lock', () => {
    const managed = readManaged(patchPath);
    managed.ids.add(rowId);
    return writeManagedLocked(patchPath, managed.ids);
  });
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
 * 环境类错误：端口占用/资源冲突/上下文未激活等，不是插件自身问题，不归因不禁用。
 */
const ENV_ERROR_PATTERNS = /EADDRINUSE|already in use|inactive context|cannot create effect on inactive|already owned by process|EACCES|EPERM|ENOSPC|ECONNREFUSED|EADDRNOTAVAIL/i;
export function isEnvError(message) {
  return ENV_ERROR_PATTERNS.test(String(message || ''));
}

/**
 * 批量失败阈值：单次启动失败数达到该值视为环境/级联问题（如多实例抢端口），
 * 此时全部只记账不自动禁用。可用环境变量 DSH_ERROR_TELL_BATCH_THRESHOLD 覆盖。
 */
export function batchThreshold() {
  // P2-9：Number("abc") → NaN 会让 `batchCount >= NaN` 恒为 false，熔断被静默击穿
  return nonNegativeInt(process.env.DSH_ERROR_TELL_BATCH_THRESHOLD, 5);
}
/**
 * 记录一次失败：账本必写（可审计）；本次运行新增禁用行数达到 maxDisable 时熔断
 * （跳过写 managed，返回 false）。注意计数是「本次运行增量」而非 managed 历史总量。
 */
export function recordFailure(home, patchPath, { rowId, pkg, stage, error, source = 'runtime-guard', maxDisable = 5, batchCount = 1, log = () => {} }) {
  if (!rowId) return false;
  // P2-9：非法配置（NaN/负数/小数）回退默认值，避免熔断条件被击穿
  maxDisable = nonNegativeInt(maxDisable, 5);
  // P2-17：id 会进 YAML/日志，非法直接拒绝（只记账不写 managed）
  if (!isValidRowId(rowId)) {
    log('[dsh-error-tell] 非法行 id，拒绝处理: ' + JSON.stringify(String(rowId).slice(0, 80)));
    return false;
  }
  if (isPendingLikeError(error)) return false; // pending 不是插件失败，不归因
  if (isEnvError(error)) {
    log('[dsh-error-tell] 环境类错误（不归因插件）: ' + rowId + ' — ' + String(error).split('\n')[0]);
    addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0] + '（环境类错误未禁用）', source: source + '-env' });
    return false;
  }
  if (batchCount >= batchThreshold()) {
    log('[dsh-error-tell] 批量失败熔断：本次启动已失败 ' + batchCount + ' 个（疑似环境/级联问题），' + rowId + ' 只记账不禁用');
    addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0] + '（批量失败熔断未禁用）', source: source + '-batch' });
    return false;
  }
  const allowProtected = process.env.DSH_ERROR_TELL_ALLOW_PROTECTED === '1';
  if (!allowProtected && isProtected(rowId, pkg)) {
    log('[dsh-error-tell] 保护名单：拒绝自动禁用核心服务 ' + rowId + '（只记账，请人工确认）');
    addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0] + '（保护名单未禁用）', source: source + '-protected' });
    return false;
  }
  // 熔断：按本次运行新增量判定（而非 managed 历史总量），避免永久自锁
  const ran = runDisabledFor(patchPath);
  if (!ran.has(rowId) && ran.size >= maxDisable) {
    log('[dsh-error-tell] 熔断：本次运行已自动禁用 ' + ran.size + ' 行（上限 ' + maxDisable + '），拒绝禁用 ' + rowId + '（账本已记录）');
    addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0] + '（熔断未禁用）', source: source + '-fuse' });
    return false;
  }
  addQuarantine(home, { rowId, package: pkg, stage, error: String(error).split('\n')[0], source });
  syncDisable(patchPath, rowId);
  ran.add(rowId);
  return true;
}