import { homedir } from 'node:os';
import { join } from 'node:path';
import { addQuarantine, restoreQuarantine, activeQuarantine, loadLedger } from '@dsh-error-tell/boot-guard';
import { readManaged, writeManaged } from '@dsh-error-tell/boot-guard';
import { INJECT_SCRIPT } from './inject-script.js';

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

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const patchPath = join(home, 'cordis.patch.yml');
  const webServer = ctx.webServer;

  // 1) 加载页注入：禁用/恢复按钮脚本（独立于插件树）
  const disposeTap = webServer.tapIndex((html) => {
    if (html.includes('dsh-error-tell-inject')) return html;
    const script = '<script>' + INJECT_SCRIPT + '</scr' + 'ipt>';
    return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html.replace('</head>', script + '</head>');
  });

  const guardHeader = (req) => req.headers[GUARD_HEADER] === '1';

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
      try {
        addQuarantine(home, { rowId: found, package: rowId, stage: 'client', error: 'browser 手动禁用（client-tell）', source: 'client-tell' });
        const managed = readManaged(patchPath);
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
          disabled.push({ rowId: e.rowId, package: e.package, stage: e.stage, source: e.source, failCount: e.failCount ?? 1, at: e.at });
        }
        for (const id of managed.ids) if (!seen.has(id)) disabled.push({ rowId: id, source: 'managed' });
        return json(res, 200, { ok: true, disabled, total: ledger.entries.length });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }
  });

  ctx.logger?.info?.('[dsh-error-tell] client-tell host active: disable/restore/status 端点 + 注入脚本');
  return () => { disposeTap(); disposeRoute(); restoreRoute(); statusRoute(); };
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
