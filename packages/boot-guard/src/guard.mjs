import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { composeRows, runDsh } from './compose.mjs';
import { runChecks, clearImportCache } from './checks.mjs';
import { loadLedger, addQuarantine, activeQuarantine, restoreQuarantine, failureCount } from './quarantine.mjs';
import { readManaged, writeManaged } from './patch-writer.mjs';
import { dshHome, homePatchPath } from './home.mjs';
import { isProtected, isPendingLikeError, isEnvError, assertPatchParseable, batchThreshold } from '@dsh-error-tell/core';

export const SELF_IDS = new Set(['error-tell-runtime', 'error-tell-client-host']);
/** P2-14：check 的 skipPackages 比对的是包名，行 id 与包名必须都给。 */
export const SELF_PACKAGES = new Set(['@dsh-error-tell/runtime-guard', '@dsh-error-tell/client-tell']);
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

/**
 * P1-2：重启归因阶段是否还能再禁用一行。
 * precheck 阶段的 assertDisableLimit 只覆盖预检那一批；重启路径每加一行都要重新判，
 * 否则多个坏插件可以借「启动失败归因」把实际禁用数顶到 maxDisable 之上。
 */
export function canAddDisable(toDisable, maxDisable) {
  return toDisable.size < maxDisable;
}

// P2-12：先把入参强制转成字符串——YAML 里 id/name 写成数字等非字符串时，
// 原来会在这里抛 TypeError 导致整个归因流程中断。
function escapeRegExp(s) { return String(s).replace(/\$/g, "\\$").replace(/[.*+?^{}()|[\]\\]/g, "\\$&"); }

/** 包名右侧允许出现的分隔符（P2-13：补上逗号/分号/句号/方括号等常见标点）。 */
const NAME_RIGHT_BOUNDARY = '[\\s"\':),;.\\]}!?]';

/**
 * 从 stderr 推断失败行（精确匹配，防误杀）：
 * 1) 行首 `<name>:`（assertEntriesActivated 的 failures 行格式）；
 * 2) 包名带边界出现（引号/空白/括号/路径分隔符包围）；
 * 3) 显式 id 引用（id: X / entry X / "X"）。
 */
export function inferFailures(stderr, rows) {
  // 事故修复：pending（依赖未满足）不是插件自身失败，相关行不参与归因
  const s = (stderr || '').split(/\r?\n/).filter(l => !isPendingLikeError(l) && !isEnvError(l)).join('\n');
  const hits = new Set();
  for (const row of rows) {
    if (!row || row.id === undefined || row.id === null || row.name === undefined || row.name === null) continue;
    const id = String(row.id);
    const name = String(row.name);
    if (!id || !name || SELF_IDS.has(id)) continue;
    const n = escapeRegExp(name);
    if (new RegExp('(?:^|[\\r\\n])' + n + ':').test(s)) { hits.add(id); continue; }
    if (new RegExp('(?:^|[\\s"\'/(])' + n + '(?=' + NAME_RIGHT_BOUNDARY + ')').test(s)) { hits.add(id); continue; }
    // 显式 id 引用：必须带词边界。原实现用裸 includes('id: ' + id)，
    // 导致 id 互为前缀时互相命中（如 'a' 命中 'id: ab'）→ 误禁用**错误的**插件。
    const rid = escapeRegExp(id);
    if (new RegExp('id:\\s*' + rid + '(?![\\w.-])').test(s)) { hits.add(id); continue; }
    if (new RegExp('(?:^|[\\s"\'/(])entry\\s+' + rid + '(?![\\w.-])').test(s)) { hits.add(id); continue; }
    if (s.includes('"' + id + '"')) hits.add(id);
  }
  return [...hits];
}

/**
 * 自动探测 dsh 安装目录（用于 import 干跑的第二个解析锚点）。
 * 为什么必须探测：官方行（如 @deepseek-ai/cordis-plugin-timer）只在 dsh 发行目录的 node_modules 里，
 * 从沙箱 profile 目录解析不到。CLI 以前从不传 dshInstall，于是**每次真实运行都会把官方行判成
 * import 失败并写进账本**（M8 的一类：干跑与真实加载管线不一致）。探测失败返回 undefined，
 * 干跑退回只用 profileDir（行为与修复前一致）。
 */
function detectDshInstall(env) {
  try {
    // 注意：不能写成 spawnSync('npm.cmd', ['root','-g'])——Node 不允许无 shell 执行 .cmd/.bat（会 EINVAL），
    // 而传 args 数组 + shell:true 又会触发 DEP0190。用「已转义的命令串」两者都避开。
    // P2-16：必须带上调用方传入的 env（自定义 npm prefix / 隔离安装路径都在 env 里），
    // 否则 npm 会按进程自身的环境去探测。
    const npmRoot = spawnSync('npm root -g', {
      encoding: 'utf8', windowsHide: true, shell: true, timeout: 15000,
      env: env ? { ...process.env, ...env } : process.env
    });
    const root = (npmRoot.stdout || '').trim();
    if (npmRoot.status === 0 && root) return join(root, '@deepseek-ai', 'dsh');
  } catch { /* 探测失败不阻塞 */ }
  return undefined;
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
 * 组装传给 dsh 的 argv。
 *
 * 这里的顺序是**契约**，不是风格：dsh launcher「只解析自己的 flag，遇到第一个
 * 自家以外的 flag 就把后面所有参数原样交给 booted tree」（`dsh/lib/bin.js` 顶部注释：
 * `dsh --profile tui --resume abc` 会把 `--resume abc` 交给 tui app）。
 * 所以 `--profile` / `--patch` 必须全部排在 app 段之前；`--no-open` 与 `--port`
 * 都是 web app 的 flag，属于 app 段。
 *
 * 实测证据（`dsh --profile s2test --dump-config --no-open --patch p.yml`）：
 *   error: config dumps take no app arguments, got "--no-open" "--patch" "…p.yml"
 * 即 launcher 段的 `--patch` 完全没被收集 —— 探针覆盖层没生效，dsh 实际仍按
 * home 层的 `disabled: true` 启动，于是「探针成功」是假的，守卫会把一个从未
 * 真正验证过的坏行自动恢复（撤销禁用）。
 *
 * @param options - profile、覆盖层、端口、quit 钩子与额外 app 参数。
 * @returns dsh 的完整 argv（launcher 段在前，app 段在后）。
 */
export function buildDshArgs({ profile, patchFiles = [], probePatchFile = null, port, quitAfterMs = 0, extraArgs = [] } = {}) {
  const args = ['--profile', profile];
  // launcher 段：用户 --patch 覆盖层 + 探针覆盖层（探针放最后 = 优先级最高）
  for (const p of patchFiles) args.push('--patch', p);
  if (probePatchFile) args.push('--patch', probePatchFile);
  // app 段：`--no-open` 是测试钩子模式用的（不弹浏览器：浏览器子进程会占住 stdio，
  // 导致 quit 判定挂到超时）；它一旦出现在 `--patch` 之前就会截断 launcher 段。
  if (quitAfterMs > 0) args.push('--no-open');
  if (port !== undefined && port !== null && port !== '') args.push('--port', String(port));
  args.push(...extraArgs);
  return args;
}

/**
 * 启动「成功」路径的兜底归因。
 *
 * 为什么需要：dsh 0.1.7-rc.2 起，插件 import/apply 失败**不再终止进程**，只在 stderr 打两行：
 *   `dsh: warning: 1 entry did not activate`
 *   `fixture-bad-import (@dsh-error-tell/fixture-bad-import): failed to import`
 * 所以「进程还活着 / 正常退出」不能等于「启动健康」。若成功路径不看 stderr：
 *   - 探针行会被判为「已验证修好」→ 自动恢复（撤销一个其实仍然坏掉的禁用）；
 *   - 普通坏行连账本都不会记。
 * 0.1.0-rc.6 时代这类失败是致命的（进程 exit≠0），所以老路径只看退出码是够的。
 *
 * 纯函数：只做分类（不落盘），便于单测。
 *
 * @param stderr - 本次启动的 stderr 原文。
 * @param rows - 组合后的行清单（供 inferFailures 做带边界匹配）。
 * @param options - probeIds：探针行集合；known：本次运行已处理过的行（避免重复计数）。
 * @returns { ids, probe, others } 未激活的行（全部 / 探针行 / 非探针行）。
 */
export function splitUnactivated(stderr, rows, { probeIds = new Set(), known = new Set() } = {}) {
  const ids = inferFailures(stderr || '', rows).filter(id => !known.has(id));
  return { ids, probe: ids.filter(id => probeIds.has(id)), others: ids.filter(id => !probeIds.has(id)) };
}

/**
 * guard 主流程：组合（含探针覆盖）→ 检查 → 连续失败判定落盘 → 启动（失败归因重启）。
 * 启动成功后自动恢复探针行（S2）。
 * 返回 { rows, issues, toDisable, probeIds, spawn, attempts, disabled }。
 */
export async function guard(opts = {}) {
  const {
    profile = 'web', patchFiles = [], dryRun = false, restartLimit = 2,
    // P1-1：port 默认 undefined = 「不向 dsh 传 --port」（沿用 dsh 自身默认端口）。
    // 原默认 0 会让 CLI 永远覆盖成临时端口，与 README「用户显式给才传」矛盾。
    dshBin = 'dsh', port, extraArgs = [], timeoutMs = 120000, maxDisable = 5,
    threshold = 2, importChecks = true, env = process.env, profileDir, dshInstall, quitAfterMs = 0,
    probe = true, log = (msg) => console.log(msg),
    // 测试缝：注入假的 dsh 运行器 / 组合器，就能在不 spawn 进程、不开端口的前提下
    // 覆盖「启动成功但行未激活」这类分支（真实 dsh 上须起进程才能到那里）。
    dshRun = runDsh, compose = composeRows
  } = opts;
  const home = dshHome(env);
  const patchPath = homePatchPath(home);
  clearImportCache(); // 每次守护重新干跑，避免复用上次（可能已修好）的 import 结果
  // 写前自检：home patch 必须可解析，否则拒绝任何 managed 写入
  try { assertPatchParseable(patchPath); } catch (e) {
    log('[dsh-error-tell] ' + e.message);
    throw e;
  }
  // M7：能力自检——记录 dsh 版本，便于私有 API 行为漂移时定位
  try {
    const v = await dshRun(dshBin, ['--version'], { env, timeoutMs: 20000 });
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
    const { rows } = await compose(profile, [...patchFiles, probePatchFile].filter(Boolean), { dshBin, env });
    const issues = await runChecks(rows, {
      importChecks,
      profileDir: profileDir || join(home, "profiles", profile),
      dshInstall: dshInstall || detectDshInstall(env),
      // P2-14：checks 里比对的是 row.name（包名），原来只传 SELF_IDS（行 id）导致自身包没被跳过
      skipPackages: [...SELF_IDS, ...SELF_PACKAGES]
    });
    const failures = issues.filter(i => i.severity === 'error');
    log("[dsh-error-tell] rows=" + rows.length + " issues=" + issues.length + " errors=" + failures.length);
    for (const i of issues) log('  [' + i.severity + '/' + i.stage + '] ' + i.rowId + ': ' + String(i.message).split('\n')[0]);

    // 本次预检失败：计算连续失败判定（dry-run 只计算不落盘，保证零副作用）
    const toDisableNow = new Set();
    const preFailures = [];
    // 批量失败熔断：单次预检失败数达到阈值视为环境/级联问题，全部只记账
    const batchMode = failures.length >= batchThreshold();
    if (batchMode) log('[dsh-error-tell] 批量失败熔断：本次预检失败 ' + failures.length + ' 个（疑似环境/级联问题），全部只记账不禁用');
    const probeFailed = new Set();
    /**
     * 归因「运行期失败」到某一行：记账 + 按阈值禁用；探针行、保护名单、批量熔断、禁用上限统一在此处理。
     * 预检（import 干跑）与启动期（stderr 归因）两条路径共用，避免规则漂移。
     * @returns 是否改动了 managed 禁用集合（true = 需要写盘）。
     */
    const attributeFailure = (id, { source, error, batch = false }) => {
      const pkgName = rows.find(r => r.id === id)?.name;
      if (probeIds.has(id)) probeFailed.add(id); // 探针行仍失败：保持禁用，禁止本次成功后误恢复
      if (batch) {
        addQuarantine(home, { rowId: id, package: pkgName, stage: 'runtime', error: error + '（批量熔断未禁用）', source: source + '-batch' });
        log('[dsh-error-tell] ' + id + '（批量熔断：只记账）');
        return false;
      }
      if (isProtected(id, pkgName)) {
        addQuarantine(home, { rowId: id, package: pkgName, stage: 'runtime', error: error + '（保护名单未禁用）', source: source + '-protected' });
        log('[dsh-error-tell] ' + id + '（保护名单：只记账，绝不自动禁用）');
        return false;
      }
      addQuarantine(home, { rowId: id, package: pkgName, stage: 'runtime', error, source });
      const n = failureCount(home, id);
      if (decideDisable(1, n - 1, threshold)) {
        // P1-2：重启归因路径此前直接 add + writeManaged，绕过了 maxDisable 熔断，
        // 多个坏插件可以借启动失败路径把实际禁用数顶到上限之上。
        // 这里按「本次运行新增量」实时校验（precheck 阶段的 assertDisableLimit 只覆盖预检那一批）。
        if (!canAddDisable(toDisableNow, maxDisable)) {
          log('[dsh-error-tell] 熔断：本次运行禁用数已达上限 ' + maxDisable + '，跳过 ' + id + '（账本已记录，未写入 managed）');
          return false;
        }
        toDisableNow.add(id);
        log('[dsh-error-tell] ' + id + ' 第' + n + '次失败 → 禁用');
        return true;
      }
      log('[dsh-error-tell] ' + id + ' 第' + n + '次失败（观察中，未禁用）');
      return false;
    };
    /** 从探针覆盖里剔除已归因失败的行（重写探针文件；返回新路径或原值）。 */
    const rewriteProbe = () => {
      if (!probePatchFile) return probePatchFile;
      const remaining = new Set([...probeIds].filter(id => !probeFailed.has(id)));
      try { unlinkSync(probePatchFile); } catch { /* 忽略 */ }
      return writeProbePatch(remaining, probeDir);
    };
    for (const f of failures) {
      const prior = failureCount(home, f.rowId);
      const n = prior + 1;
      if (probeIds.has(f.rowId)) probeFailed.add(f.rowId); // 探针行仍失败：保持禁用，禁止本次成功后误恢复
      if (batchMode || isEnvError(f.message)) {
        log('  [第' + n + '次失败] ' + f.rowId + (batchMode ? '（批量熔断：只记账）' : '（环境类错误：不归因）'));
        preFailures.push(f);
        continue;
      }
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
    let cleanAttemptDone = !probePatchFile; // 无探针时首次启动即干净启动
    // 退出条件全部在循环体内（成功 / 次数用尽 / 无法归因），允许探针失败后追加一次干净启动
    for (let attempt = 0; ; attempt++) {
      attempts = attempt + 1;
      if (attempt > 0) {
        const why = newFailures.length ? newFailures.join(', ') : '（stderr 归因）';
        log('[dsh-error-tell] 重启 ' + attempt + '/' + restartLimit + '（新禁用: ' + why + '）');
      }
      const args = buildDshArgs({ profile, patchFiles, probePatchFile, port, quitAfterMs, extraArgs });
      last = await dshRun(dshBin, args, { env, timeoutMs, quitAfterMs });
      if (last.quit || (last.code !== null && NORMAL_EXITS.has(last.code))) {
        if (last.quit) log('[dsh-error-tell] 服务正常运行中（测试 quit 钩子触发）');
        else log('[dsh-error-tell] dsh 正常结束（exit ' + last.code + '）');
        let dirty = false;
        // 启动「成功」也要看 stderr：0.1.7-rc.2 起未激活的行不会终止进程（详见 splitUnactivated 注释）
        const survived = splitUnactivated(last.stderr || '', rows, { probeIds, known: toDisableNow });
        const newlyDisabled = [];
        if (survived.ids.length) {
          log('[dsh-error-tell] 进程存活但 ' + survived.ids.length + ' 行未激活（stderr 归因）: ' + survived.ids.join(', '));
          for (const id of survived.probe) {
            probeFailed.add(id); // 关键：探针行不许恢复，否则撤销一个并未修好的禁用
            log('[dsh-error-tell]   ' + id + '（探针行仍未激活，保持禁用）');
          }
          for (const id of survived.others) {
            if (attributeFailure(id, { source: 'boot-guard-survived-boot', error: '进程存活但该行未激活（stderr 归因）' })) {
              dirty = true;
              newlyDisabled.push(id);
            }
          }
        }
        // 探针行其实没激活 → 不能恢复。剔除探针后再做一次干净启动，
        // 保证用户拿到的是「坏行已禁用」的可用实例（与失败路径同一套收尾逻辑）。
        if (survived.probe.length && !cleanAttemptDone) {
          cleanAttemptDone = true;
          log('[dsh-error-tell] 探针行仍失败（' + [...probeFailed].join(', ') + '），剔除探针追加一次干净启动，保证禁用生效');
          probePatchFile = rewriteProbe();
          writeManaged(patchPath, new Set([...managedIds, ...toDisableNow]));
          newFailures = survived.probe;
          continue;
        }
        // 归因新增禁用 → 也要重启一次：0.1.7-rc.2 上「应用/导入失败但进程活着」的实例是坏实例，
        // 若就此返回 ok，用户拿到的是少一行/坏一行的服务（下一轮才会生效）。与失败路径语义一致。
        if (newlyDisabled.length && attempt < restartLimit) {
          log('[dsh-error-tell] 已归因禁用 ' + newlyDisabled.join(', ') + '（' + attempt + '/' + restartLimit + '），重启一次以交付干净实例');
          writeManaged(patchPath, new Set([...managedIds, ...toDisableNow]));
          newFailures = newlyDisabled;
          continue;
        }
        if (newlyDisabled.length) log('[dsh-error-tell] 已归因禁用 ' + newlyDisabled.join(', ') + '，但重启次数已用尽（' + attempt + '/' + restartLimit + '），下次启动生效');
        // 探针成功 → 自动恢复：只恢复「本次未归因失败」的探针行（仍坏的行保持禁用）
        const restoreIds = new Set([...probeIds].filter(id => !probeFailed.has(id)));
        if (restoreIds.size) {
          const restored = [];
          for (const id of restoreIds) if (restoreQuarantine(home, id)) restored.push(id);
          dirty = true;
          log('[dsh-error-tell] 探针成功，已自动恢复: ' + (restored.join(', ') || '(无)') + (probeFailed.size ? '；仍失败保持禁用: ' + [...probeFailed].join(', ') : ''));
        } else if (probeFailed.size) {
          log('[dsh-error-tell] 探针行仍失败，保持禁用: ' + [...probeFailed].join(', '));
        }
        if (dirty) writeManaged(patchPath, new Set([...managedIds, ...toDisableNow].filter(id => !restoreIds.has(id))));
        break;
      }
      if (last.code !== null && !NORMAL_EXITS.has(last.code)) {
        const tail = (last.stderr || '').slice(-600);
        log('[dsh-error-tell] dsh 启动失败 exit=' + last.code + ' stderrLen=' + (last.stderr || '').length + (tail ? '\n  stderr tail: ' + tail.replace(/\n/g, '\n  ') : ''));
      }
      // 归因必须先于 restartLimit 判定：restart-limit 0 时失败也要记账/禁用
      newFailures = inferFailures(last.stderr || "", rows).filter(id => !toDisableNow.has(id));
      const batchMode = newFailures.length >= batchThreshold();
      if (batchMode) log('[dsh-error-tell] 批量失败熔断：本次归因 ' + newFailures.length + ' 个（疑似环境/级联问题），全部只记账不禁用');
      for (const id of newFailures) {
        attributeFailure(id, { source: 'boot-guard-restart', error: 'dsh 启动失败（见 stderr）', batch: batchMode });
      }
      writeManaged(patchPath, new Set([...managedIds, ...toDisableNow]));
      // 归因命中探针行：从探针覆盖中剔除（否则重启仍会覆盖启用该行）
      if (probePatchFile && newFailures.some(id => probeIds.has(id))) probePatchFile = rewriteProbe();
      // 重启次数用尽但探针仍失败：剔除探针后追加一次干净启动（保证禁用生效、web 能开）
      if (attempt >= restartLimit) {
        if (!cleanAttemptDone) {
          cleanAttemptDone = true;
          log('[dsh-error-tell] 探针行仍失败（' + [...probeFailed].join(', ') + '），剔除探针追加一次干净启动，保证禁用生效');
          continue;
        }
        break;
      }
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
