import { join } from 'node:path';
import { composeRows, runDsh } from './compose.mjs';
import { runChecks } from './checks.mjs';
import { loadLedger, addQuarantine, activeQuarantine } from './quarantine.mjs';
import { readManaged, writeManaged } from './patch-writer.mjs';
import { dshHome, homePatchPath } from './home.mjs';

export const SELF_IDS = new Set(['error-tell-runtime', 'error-tell-client-host']);
export const NORMAL_EXITS = new Set([0, 130, 143]);

/** 从 stderr 推断失败行：行名或行 id 出现在输出中即命中。 */
export function inferFailures(stderr, rows) {
  const hits = new Set();
  for (const row of rows) {
    if (!row.id || !row.name || SELF_IDS.has(row.id)) continue;
    const s = stderr || "";
    if (s.includes(row.name)) { hits.add(row.id); continue; }
    if (s.includes("id: " + row.id) || s.includes("entry " + row.id) || s.includes("\"" + row.id + "\"")) hits.add(row.id);
  }
  return [...hits];
}

/**
 * guard 主流程：组合 → 检查 → 落盘禁用 → 启动（失败归因重启）。
 * 返回 { rows, issues, toDisable, spawn, attempts, disabled }。
 */
export async function guard(opts = {}) {
  const {
    profile = 'web', patchFiles = [], dryRun = false, restartLimit = 2,
    dshBin = 'dsh', port = 0, extraArgs = [], timeoutMs = 120000,
    env = process.env, profileDir, dshInstall, quitAfterMs = 0,
    log = (msg) => console.log(msg)
  } = opts;
  const home = dshHome(env);
  const { rows } = await composeRows(profile, patchFiles, { dshBin, env });
  const issues = await runChecks(rows, {
    profileDir: profileDir || join(home, "profiles", profile),
    dshInstall,
    skipPackages: [...SELF_IDS]
  });
  const failures = issues.filter(i => i.severity === 'error');
  log("[dsh-error-tell] rows=" + rows.length + " issues=" + issues.length + " errors=" + failures.length);
  for (const i of issues) log('  [' + i.severity + '/' + i.stage + '] ' + i.rowId + ': ' + String(i.message).split('\n')[0]);

  const ledger = loadLedger(home);
  const toDisable = new Set(readManaged(homePatchPath(home)).ids);
  for (const e of activeQuarantine(home)) toDisable.add(e.rowId);
  for (const f of failures) toDisable.add(f.rowId);

  if (dryRun) {
    for (const id of toDisable) log("  [plan] disable " + id);
    return { rows, issues, toDisable: [...toDisable], dryRun: true, spawn: null, attempts: 0, disabled: [] };
  }

  for (const f of failures) {
    addQuarantine(home, {
      rowId: f.rowId, package: f.package ?? (rows.find(r => r.id === f.rowId)?.name), stage: f.stage,
      error: String(f.message).split('\n')[0], source: 'boot-guard'
    });
  }
  const firstWrite = writeManaged(homePatchPath(home), toDisable);
  if (firstWrite.ids.length) log("[dsh-error-tell] 已禁用 → " + homePatchPath(home) + ": " + firstWrite.ids.join(", "));

  const spawnArgs = ['--profile', profile];
  if (port !== undefined && port !== null && port !== '') spawnArgs.push('--port', String(port));
  spawnArgs.push(...extraArgs);

  let last = null;
  let attempts = 0;
  let newFailures = [];
  for (let attempt = 0; attempt <= restartLimit; attempt++) {
    attempts = attempt + 1;
    if (attempt > 0) {
      const why = newFailures.length ? newFailures.join(", ") : "（stderr 归因）";
      log("[dsh-error-tell] 重启 " + attempt + "/" + restartLimit + "（新禁用: " + why + "）");
    }
    last = await runDsh(dshBin, spawnArgs, { env, timeoutMs, quitAfterMs });
    if (last.quit) { log("[dsh-error-tell] 服务正常运行中（测试 quit 钩子触发）"); break; }
    if (last.code !== null && NORMAL_EXITS.has(last.code)) { log("[dsh-error-tell] dsh 正常结束（exit " + last.code + "）"); break; }
    if (last.code !== null && !NORMAL_EXITS.has(last.code)) {
      const tail = (last.stderr || '').slice(-600);
      log('[dsh-error-tell] dsh 启动失败 exit=' + last.code + ' stderrLen=' + (last.stderr || '').length + (tail ? '\n  stderr tail: ' + tail.replace(/\n/g, '\n  ') : ''));
    }
    if (attempt === restartLimit) break;
    newFailures = inferFailures(last.stderr || "", rows).filter(id => !toDisable.has(id));
    if (!newFailures.length) { log("[dsh-error-tell] 无法从 stderr 归因失败行，熔断不循环"); break; }
    for (const id of newFailures) {
      toDisable.add(id);
      addQuarantine(home, { rowId: id, stage: 'runtime', error: 'dsh 启动失败（见 stderr）', source: 'boot-guard-restart' });
    }
    writeManaged(homePatchPath(home), toDisable);
  }
  return { rows, issues, toDisable: [...toDisable], spawn: last, attempts, disabled: [...toDisable] };
}
