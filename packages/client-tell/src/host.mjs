import { homedir } from 'node:os';
import { join } from 'node:path';
import { addQuarantine } from '@dsh-error-tell/boot-guard';
import { readManaged, writeManaged } from '@dsh-error-tell/boot-guard';
import { INJECT_SCRIPT } from './inject-script.js';

export const name = 'error-tell-client-host';
export const inject = ['webServer'];

const SELF = 'error-tell-client-host';

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

  // 1) 加载页注入：禁用按钮脚本（独立于插件树）
  const disposeTap = webServer.tapIndex((html) => {
    if (html.includes('dsh-error-tell-inject')) return html;
    const script = '<script>' + INJECT_SCRIPT + '</scr' + 'ipt>';
    return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html.replace('</head>', script + '</head>');
  });

  // 2) 禁用端点（exact 路由优先于 /api 前缀网关）
  const disposeRoute = webServer.register({
    kind: 'exact',
    path: '/api/error-tell/disable',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      if (req.headers['x-dsh-error-tell'] !== '1') return json(res, 403, { ok: false, error: 'missing guard header' });
      const raw = await readBody(req);
      let rowId;
      try { rowId = JSON.parse(raw || '{}').rowId; } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      if (!rowId || typeof rowId !== 'string') return json(res, 400, { ok: false, error: 'rowId required' });

      // 解析：entry.id 或 entry.options.name 均可
      let entry = null;
      try {
        for (const e of ctx.loader.entries()) {
          if (e.options.group) continue;
          if (e.options.id === rowId || e.options.name === rowId) { entry = e; break; }
        }
      } catch { /* loader 未就绪 */ }
      if (!entry) return json(res, 404, { ok: false, error: 'row not found: ' + rowId });
      const id = entry.options.id;
      if (id === SELF || String(id).startsWith('error-tell-')) return json(res, 403, { ok: false, error: 'refusing to disable self/guard row' });

      try {
        addQuarantine(home, { rowId: id, package: entry.options.name, stage: 'client', error: 'browser 手动禁用（client-tell）', source: 'client-tell' });
        const managed = readManaged(patchPath);
        managed.ids.add(id);
        writeManaged(patchPath, managed.ids);
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
      return json(res, 200, { ok: true, rowId: id, hint: 'reload the page' });
    }
  });

  ctx.logger?.info?.('[dsh-error-tell] client-tell host active: 注入脚本 + POST /api/error-tell/disable');
  return () => { disposeTap(); disposeRoute(); };
}
