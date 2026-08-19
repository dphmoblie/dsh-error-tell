import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { composeRows, runDsh } from './compose.mjs';
import { runChecks } from './checks.mjs';
import { loadLedger, addQuarantine, activeQuarantine, restoreQuarantine, failureCount } from './quarantine.mjs';
import { readManaged, writeManaged } from './patch-writer.mjs';
import { dshHome, homePatchPath } from './home.mjs';
import { isProtected, isPendingLikeError, assertPatchParseable } from '@dsh-error-tell/core';

export const SELF_IDS = new Set(['error-tell-runtime', 'error-tell-client-host']);
export const NORMAL_EXITS = new Set([0, 130, 143]);

/**
 * S2：连续失败判定——本次失败数 + 此前累计失败数达到 threshold 才真正禁用（防瞬态误杀）。
 */
export function decideDisable(failures, prior, threshold = 2) {
  return failures + prior >= threshold;
}

/** 熔断：单次待禁用行数超过上限时拒绝继续（防误杀），且不修改任何配置。 */
export function assertDisableLimit(toDisable, maxDisable, log = () => {}) {
  if (toDisable.size > maxDisable) {
    log('[dsh-error-tell] 熔断：本次需禁用 ' + toDisable.size + ' 行（上限 ' + maxDisable + '），拒绝自动修改配置，请人工检查');
    throw new Error('熔断：待禁用行数 ' + toDisable.size + ' 超过上限 ' + maxDisable + '（可能误判，未修改任何配置）');
  }
}

function escapeRegExp(s) { return s.replace(/\$/g, "\\$").replace(/[.*+?^{}()|[\]\\]/g, "\\$&"); }

/**
 * 从 stderr 推断失败行（精确匹配，防误杀）：
 * 1) 行首 `<name>:`（assertEntriesActivated 的 failures 行格式）；
 * 2) 包名带边界出现（引号/空白/括号/路径分隔符包围）；
 * 3) 显式 id 引用（id: X / entry X / "X"）。
 */
export function inferFailures(stderr, rows) {
  // 事故修复：pending（依赖未满足）不是插件自身失败，相关行不参与归因
  const s = (stderr || '').split(/\r?\n/).filter(l => !isPendingLikeError(l)).join('\n');
  const hits = new Set();
  for (const row of rows) {
    if (!row.id || !row.name || SELF_IDS.has(row.id)) continue;
    const n = escapeRegExp(row.name);
    if (new RegExp('(?:^|[\\r\\n])' + n + ':').test(s)) { hits.add(row.id); continue; }
    if (new RegExp('(?:^|[\\s"\'/(])' + n + '(?=[\\s"\':)])').test(s)) { hits.add(row.id); continue; }
    if (s.includes('id: ' + row.id) || s.includes('entry ' + row.id) || s.includes('"' + row.id + '"')) hits.add(row.id);
  }
  return [...hits];
}

/** 生成探针覆盖 patch：把已禁用行临时覆盖为 disabled: false（真实加载一次验证是否已修复）。 */
export function writeProbePatch(ids, dir) {
  if (!ids || ids.size === 0) return null;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'dsh-error-tell-probe-' + Math.random().toString(16).slice(2) + '.yml');
  const content = [...ids].sort().map(id => '- id: ' + id + '\n  disabled: false').join('\n') + '\n';
  writeFileSync(file, content, "utf8");
  return file;
}

/**
 * guard 主流程：组合（含探针覆盖）→ 检查 → 连续失败判定落盘 → 启动（失败归因重启）。
 * 启动成功后自动恢复探针行（S2）。
 * 返回 { rows, issues, toDisable, probeIds, spawn, attempts, disabled }。
 */
export async function guard(opts = {}) {
  const {
    profile = 'web', patchFiles = [], dryRun = false, restartLimit = 2,
    dshBin = 'dsh', port = 0, extraArgs = [], timeoutMs = 120000, maxDisable = 5,
    threshold = 2, importChecks = true, env = process.env, profileDir, dshInstall, quitAfterMs = 0,
    probe = true, log = (msg) => console.log(msg)
  } = opts;
  const home = dshHome(env);
  const patchPath = homePatchPath(home);
  // 写前自检：home patch 必须可解析，否则拒绝任何 managed 写入
  try { assertPatchParseable(patchPath); } catch (e) {
    log('[dsh-error-tell] ' + e.message);
    throw e;
  }
  // M7：能力自检——记录 dsh 版本，便于私有 API 行为漂移时定位
  try {
    const v = await runDsh(dshBin, ['--version'], { env, timeoutMs: 20000 });
    if (v.code === 0 && (v.stdout || '').trim()) log('[dsh-error-tell] dsh 版本: ' + (v.stdout || '').trim().split('\n')[0]);
  } catch { /* 版本探测失败不阻塞 */ }
  const probeDir = join(tmpdir(), "dsh-error-tell");

  // 启动前已禁用的行（managed 段 + 账本中达到熔断阈值的活动记录）→ 探针临时启用。
  // 注意：账本中 failCount 未达阈值（观察中）的行尚未禁用，不应纳入探针，
  // 否则刚写入的 managed 禁用会被探针的 disabled:false 覆盖，导致坏插件真实加载。
  const managedIds = new Set(readManaged(patchPath).ids);
  const activeIds = new Set(
    activeQuarantine(home)
      .filter(e => (e.failCount ?? 1) >= threshold)
      .map(e => e.rowId)
  );
  const probeIds = probe ? new Set([...managedIds, ...activeIds]) : new Set();
  let probePatchFile = null;
  try {
    probePatchFile = writeProbePatch(probeIds, probeDir);
    const { rows } = await composeRows(profile, [...patchFiles, probePatchFile].filter(Boolean), { dshBin, env });
    const issues = await runChecks(rows, {
      importChecks,
      profileDir: profileDir || join(home, "profiles", profile),
      dshInstall,
      skipPackages: [...SELF_IDS]
    });
    const failures = issues.filter(i => i.severity === 'error');
    log("[dsh-error-tell] rows=" + rows.length + " issues=" + issues.length + " errors=" + failures.length);
    for (const i of issues) log('  [' + i.severity + '/' + i.stage + '] ' + i.rowId + ': ' + String(i.message).split('\n')[0]);

    // 本次预检失败：计算连续失败判定（dry-run 只计算不落盘，保证零副作用）
    const toDisableNow = new Set();
    const preFailures = [];
    for (const f of failures) {
      const prior = failureCount(home, f.rowId);
      const n = prior + 1;
      if (isProtected(f.rowId, f.package)) {
        log('  [第' + n + '次失败] ' + f.rowId + '（保护名单：只记账，绝不自动禁用）');
        preFailures.push(f);
        continue;
      }
      const willDisable = decideDisable(1, prior, threshold);
      log('  [第' + n + '次失败] ' + f.rowId + (willDisable ? ' → 本次禁用' : '（观察中，未禁用）'));
      if (willDisable) toDisableNow.add(f.rowId);
      preFailures.push(f);
    }
    if (probeIds.size) log('[dsh-error-tell] 探针行（启动前已禁用，本次临时启用验证）: ' + [...probeIds].join(', '));
    if (dryRun) {
      for (const id of toDisableNow) log('  [plan] disable ' + id);
      return { rows, issues, toDisable: [...toDisableNow], probeIds: [...probeIds], dryRun: true, spawn: null, attempts: 0, disabled: [] };
    }
    // 真实模式才落账本
    for (const f of preFailures) {
      addQuarantine(home, {
        rowId: f.rowId, package: f.package ?? (rows.find(r => r.id === f.rowId)?.name), stage: f.stage,
        error: String(f.message).split('\n')[0], source: 'boot-guard'
      });
    }
    assertDisableLimit(toDisableNow, maxDisable, log);
    // 写 managed：既有 managed 集合 + 本次新增（探针行保持禁用态不变）
    writeManaged(patchPath, new Set([...managedIds, ...toDisableNow]));
    if (toDisableNow.size) log('[dsh-error-tell] 已禁用 → ' + patchPath + ': ' + [...toDisableNow].join(', '));

    let last = null;
    let attempts = 0;
    let newFailures = [];
    for (let attempt = 0; attempt <= restartLimit; attempt++) {
      attempts = attempt + 1;
      if (attempt > 0) {
        const why = newFailures.length ? newFailures.join(', ') : '（stderr 归因）';
        log('[dsh-error-tell] 重启 ' + attempt + '/' + restartLimit + '（新禁用: ' + why + '）');
      }
      // 参数顺序：--patch 是 launcher 选项，必须排在 --port（app 内层参数起点）之前
      const args = ["--profile", profile];
      // M2：用户 --patch 覆盖层与探针覆盖层都传给 dsh（保持预检与启动同一棵树）
      for (const p of patchFiles) args.push('--patch', p);
      if (probePatchFile) args.push('--patch', probePatchFile);
      if (port !== undefined && port !== null && port !== '') args.push('--port', String(port));
      args.push(...extraArgs);
      last = await runDsh(dshBin, args, { env, timeoutMs, quitAfterMs });
      if (last.quit || (last.code !== null && NORMAL_EXITS.has(last.code))) {
        if (last.quit) log('[dsh-error-tell] 服务正常运行中（测试 quit 钩子触发）');
        else log('[dsh-error-tell] dsh 正常结束（exit ' + last.code + '）');
        // 探针成功 → 自动恢复：账本标记 + 从 managed 段移除
        if (probeIds.size) {
          const restored = [];
          for (const id of probeIds) if (restoreQuarantine(home, id)) restored.push(id);
          writeManaged(patchPath, new Set([...managedIds].filter(id => !probeIds.has(id))));
          log('[dsh-error-tell] 探针成功，已自动恢复: ' + (restored.join(', ') || '(managed 已移除)'));
        }
        break;
      }
      if (last.code !== null && !NORMAL_EXITS.has(last.code)) {
        const tail = (last.stderr || '').slice(-600);
        log('[dsh-error-tell] dsh 启动失败 exit=' + last.code + ' stderrLen=' + (last.stderr || '').length + (tail ? '\n  stderr tail: ' + tail.replace(/\n/g, '\n  ') : ''));
      }
      // 归因必须先于 restartLimit 判定：restart-limit 0 时失败也要记账/禁用
      newFailures = inferFailures(last.stderr || "", rows).filter(id => !toDisableNow.has(id));
      for (const id of newFailures) {
        const row = rows.find(r2 => r2.id === id);
        const pkgName = row?.name;
        if (isProtected(id, pkgName)) {
          addQuarantine(home, { rowId: id, package: pkgName, stage: 'runtime', error: 'dsh 启动失败（见 stderr）（保护名单未禁用）', source: 'boot-guard-restart-protected' });
          log('[dsh-error-tell] ' + id + '（保护名单：只记账，绝不自动禁用）');
          continue;
        }
        addQuarantine(home, { rowId: id, package: pkgName, stage: 'runtime', error: 'dsh 启动失败（见 stderr）', source: 'boot-guard-restart' });
        const n = failureCount(home, id);
        if (decideDisable(1, n - 1, threshold)) {
          toDisableNow.add(id);
          log('[dsh-error-tell] ' + id + ' 第' + n + '次失败 → 禁用');
        } else log('[dsh-error-tell] ' + id + ' 第' + n + '次失败（观察中，未禁用）');
      }
      writeManaged(patchPath, new Set([...managedIds, ...toDisableNow]));
      // 归因命中探针行：从探针覆盖中剔除（否则重启仍会覆盖启用该行）
      if (probePatchFile && newFailures.some(id => probeIds.has(id))) {
        const remaining = new Set([...probeIds].filter(id => !toDisableNow.has(id)));
        try { unlinkSync(probePatchFile); } catch { /* 忽略 */ }
        probePatchFile = writeProbePatch(remaining, probeDir);
      }
      if (attempt === restartLimit) break;
      if (!newFailures.length) { log('[dsh-error-tell] 无法从 stderr 归因失败行，熔断不循环'); break; }
    }
    if (last && !(last.quit || (last.code !== null && NORMAL_EXITS.has(last.code)))) {
      log('[dsh-error-tell] 重启次数用尽（attempts=' + attempts + '），web 仍未正常启动；本次归因: ' + (newFailures.length ? newFailures.join(', ') : '（无归因，见上方 stderr）') + '；请人工检查配置');
    }
    return { rows, issues, toDisable: [...toDisableNow], probeIds: [...probeIds], spawn: last, attempts, disabled: [...toDisableNow] };
  } finally {
    if (probePatchFile) try { unlinkSync(probePatchFile); } catch { /* 忽略 */ }
  }
}
