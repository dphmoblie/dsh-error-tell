import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addQuarantine, restoreQuarantine, activeQuarantine, loadLedger, readManaged, writeManaged, isProtected } from '@dsh-error-tell/core';
import { INJECT_SCRIPT } from './inject-script.js';
import { makeMetaResolver } from './meta.mjs';

export const name = 'error-tell-client-host';
export const inject = ['webServer'];

const SELF = 'error-tell-client-host';
const GUARD_HEADER = 'x-dsh-error-tell';

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 65536) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * 行分类解析器：官方 = 行名解析到的包位于 dsh 发行目录（@deepseek-ai/dsh 自带 node_modules）内，
 * 或名字以 @deepseek-ai/ 与 cordis: 开头；其余（profile 里用户装的包、./xxx.mjs 本地文件等）→ third。
 * 这样即使官方行不用 @deepseek-ai 名字也能正确归位。
 */
export function makeKindResolver(bases) {
  const list = (Array.isArray(bases) ? bases : [bases]).filter(Boolean);
  let req = null;
  let officialRoot = null;
  for (const b of list) {
    try {
      const candidate = createRequire(pathToFileURL(join(b, '__dsh_error_tell_kind__.js')));
      const dshPkg = candidate.resolve('@deepseek-ai/dsh/package.json');
      req = candidate;
      officialRoot = join(dirname(dshPkg), 'node_modules');
      break;
    } catch { /* 该锚点解析不到 dsh，试下一个 */ }
  }
  const cache = new Map();
  return function kindOf(name) {
    const n = String(name || '');
    if (n.startsWith('@deepseek-ai/') || n.startsWith('cordis:')) return 'official';
    if (!req || !officialRoot) return 'third';
    if (cache.has(n)) return cache.get(n);
    let kind = 'third';
    try {
      const p = req.resolve(n + '/package.json');
      if (p.startsWith(officialRoot)) kind = 'official';
    } catch { /* 不可解析（相对文件/裸名等）→ third */ }
    cache.set(n, kind);
    return kind;
  };
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const patchPath = join(home, 'cordis.patch.yml');
  const webServer = ctx.webServer;
  // M3：per-page 随机 token，注入脚本携带，端点校验（跨域页面无法读取）
  const token = process.env.DSH_ERROR_TELL_TOKEN || randomBytes(16).toString('hex');
  const maxDisable = Number(process.env.DSH_ERROR_TELL_MAX_DISABLE || 5);

  // 插件元数据解析（package.json description → 面板历史记录展示「这个插件是干什么的」）
  // 解析锚点：loader baseUrl（profile 目录）→ 进程 cwd → ~/.dsh/profiles 下各 profile 目录
  const profileBases = [];
  try {
    for (const e of ctx.loader.entries()) {
      const b = e.parent?.tree?.ctx?.baseUrl;
      if (!b) continue;
      profileBases.push(b.startsWith('file:') ? fileURLToPath(b) : String(b));
    }
  } catch { /* loader 未就绪 */ }
  if (process.cwd()) profileBases.push(process.cwd());
  try { for (const d of readdirSync(join(home, 'profiles'), { withFileTypes: true })) if (d.isDirectory()) profileBases.push(join(home, 'profiles', d.name)); } catch { /* 无 profiles 目录 */ }
  const metaResolver = makeMetaResolver(profileBases);
  const kindOf = makeKindResolver(profileBases);
  const idToName = new Map();
  try {
    for (const e of ctx.loader.entries()) {
      if (e.options?.id && e.options?.name && !e.options.group) idToName.set(e.options.id, e.options.name);
    }
  } catch { /* loader 未就绪 */ }
  const describe = (row) => {
    const rowId = row.rowId;
    const pkgName = (row.package && row.package !== rowId) ? row.package : (idToName.get(rowId) || null);
    const meta = pkgName ? metaResolver(pkgName) : null;
    return {
      rowId,
      package: pkgName || row.package || null,
      name: (meta && meta.name) || pkgName || null,
      desc: (meta && meta.description) || null
    };
  };

  // 1) 加载页注入：禁用/恢复按钮脚本（独立于插件树）
  const disposeTap = webServer.tapIndex((html) => {
    if (html.includes('data-dsh-error-tell')) return html; // 防重复注入标记（与脚本内面板标记一致）
    const script = '<script>' + INJECT_SCRIPT.replaceAll('__DSH_ERROR_TOKEN__', token) + '</scr' + 'ipt>';
    return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html.replace('</head>', script + '</head>');
  });

  const guardHeader = (req) => req.headers[GUARD_HEADER] === '1' && req.headers['x-dsh-error-token'] === token;

  // 2) 禁用端点
  const disposeRoute = webServer.register({
    kind: 'exact',
    path: '/api/error-tell/disable',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      if (!guardHeader(req)) return json(res, 403, { ok: false, error: 'missing guard header' });
      const raw = await readBody(req);
      let rowId;
      try { rowId = JSON.parse(raw || '{}').rowId; } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      if (!rowId || typeof rowId !== 'string') return json(res, 400, { ok: false, error: 'rowId required' });
      const found = resolveRow(ctx, rowId);
      if (!found) return json(res, 404, { ok: false, error: 'row not found: ' + rowId });
      if (found === SELF || String(found).startsWith('error-tell-')) return json(res, 403, { ok: false, error: 'refusing to disable self/guard row' });
      if (isProtected(found, rowId)) return json(res, 403, { ok: false, error: 'refusing to disable protected core service: ' + found });
      try {
        addQuarantine(home, { rowId: found, package: rowId, stage: 'client', error: 'browser 手动禁用（client-tell）', source: 'client-tell' });
        const managed = readManaged(patchPath);
        if (managed.ids.size >= maxDisable) {
          return json(res, 429, { ok: false, error: 'disabled count limit reached (' + maxDisable + ')' });
        }
        managed.ids.add(found);
        writeManaged(patchPath, managed.ids);
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
      return json(res, 200, { ok: true, rowId: found, hint: 'reload the page' });
    }
  });

  // 3) 恢复端点（S2 管理面板）
  const restoreRoute = webServer.register({
    kind: 'exact',
    path: '/api/error-tell/restore',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      if (!guardHeader(req)) return json(res, 403, { ok: false, error: 'missing guard header' });
      const raw = await readBody(req);
      let rowId;
      try { rowId = JSON.parse(raw || '{}').rowId; } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      if (!rowId || typeof rowId !== 'string') return json(res, 400, { ok: false, error: 'rowId required' });
      try {
        const hit = restoreQuarantine(home, rowId);
        const managed = readManaged(patchPath);
        const removed = managed.ids.delete(rowId);
        writeManaged(patchPath, managed.ids);
        return json(res, 200, { ok: true, rowId, restored: hit || removed, hint: 'reload the page' });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }
  });

  // 4) 状态端点：活动禁用列表（管理面板数据源）
  const statusRoute = webServer.register({
    kind: 'exact',
    path: '/api/error-tell/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
      if (!guardHeader(req)) return json(res, 403, { ok: false, error: 'missing guard header' });
      try {
        const ledger = loadLedger(home);
        const managed = readManaged(patchPath);
        const disabled = [];
        const seen = new Set();
        for (const e of activeQuarantine(home)) {
          seen.add(e.rowId);
          // 建议3：标注是否真实禁用（managed 段内 = 已禁用；否则仅记录）
          // 附插件功能描述（desc/name/package），方便使用的人排错
          disabled.push({ ...describe(e), stage: e.stage, source: e.source, error: e.error || null, failCount: e.failCount ?? 1, at: e.at, disabled: managed.ids.has(e.rowId) });
        }
        for (const id of managed.ids) {
          if (seen.has(id)) continue;
          disabled.push({ ...describe({ rowId: id }), source: 'managed', disabled: true });
        }
        // 环境/批量问题提示（最近活动记录中是否存在）
        const environmentIssue = ledger.entries.slice(-20).some(e2 => !e2.restoredAt && /-batch|-env/.test(e2.source || ''));
        return json(res, 200, { ok: true, disabled, total: ledger.entries.length, environmentIssue });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }
  });

  // 5) 插件列表端点：设置页「错误看门狗」分区数据源（读取全部插件 + 手动禁用/恢复）
  const pluginsRoute = webServer.register({
    kind: 'exact',
    path: '/api/error-tell/plugins',
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
      if (!guardHeader(req)) return json(res, 403, { ok: false, error: 'missing guard header' });
      try {
        const managed = readManaged(patchPath);
        const plugins = [];
        const seen = new Set();
        for (const e of ctx.loader.entries()) {
          const o = e?.options ?? {};
          if (!o.id || seen.has(o.id)) continue;
          seen.add(o.id);
          if (o.group) {
            plugins.push({ rowId: o.id, name: o.name || null, group: true, disabled: !!e.disabled, kind: kindOf(o.name) });
            continue;
          }
          let state = 'idle';
          try { if (e.fiber) state = e.fiber.state === 3 ? 'failed' : (e.fiber.uid ? 'active' : 'idle'); } catch { /* fiber 未就绪 */ }
          const meta = describe({ rowId: o.id, package: o.name });
          plugins.push({
            ...meta,
            group: false,
            state,
            disabled: !!e.disabled,
            managed: managed.ids.has(o.id),
            protected: isProtected(o.id, o.name),
            guard: o.id === SELF || String(o.id).startsWith('error-tell-'),
            kind: kindOf(o.name)
          });
        }
        return json(res, 200, { ok: true, plugins, total: plugins.length });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }
  });

  ctx.logger?.info?.('[dsh-error-tell] client-tell host active: disable/restore/status/plugins 端点 + 注入脚本');
  return () => { disposeTap(); disposeRoute(); restoreRoute(); statusRoute(); pluginsRoute(); };
}

function resolveRow(ctx, rowId) {
  try {
    for (const e of ctx.loader.entries()) {
      if (e.options.group) continue;
      if (e.options.id === rowId || e.options.name === rowId) return e.options.id;
    }
  } catch { /* loader 未就绪 */ }
  return null;
}
