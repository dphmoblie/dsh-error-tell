// 注入脚本：保持纯字符串导出（无模板插值，token 占位符由 host 替换）。
export const INJECT_SCRIPT = `
// dsh-error-tell 注入脚本：
// 1) 加载页失败时提供「禁用并重载」按钮；
// 2) 正常页面右下角常驻可拖动徽标（err-tell），点击展开：被禁用插件列表 + 恢复按钮 + 端点状态。
//    面板锚定在徽标旁边（拖动徽标时面板跟随移动）；历史记录显示插件功能描述（来自 package.json）。
(function () {
  var API = '/api/error-tell';
  var HDR = { 'x-dsh-error-tell': '1', 'x-dsh-error-token': '__DSH_ERROR_TOKEN__' };
  var statusTries = 0;
  var observer = null;
  var done = false;
  var badge = null;
  var panel = null;
  var lastStatus = null;
  var PANEL_W = 340;

  // 供设置页客户端模块（错误看门狗分区）调用受保护端点时携带 token
  try { window.__DSH_ERROR_TELL__ = window.__DSH_ERROR_TELL__ || { token: '__DSH_ERROR_TOKEN__' }; } catch (e) {}

  function text(el) { return (el && el.textContent || '').trim(); }

  function el(tag, style) {
    var e = document.createElement(tag);
    if (style) e.style.cssText = style;
    return e;
  }

  function extractFailedNames(root) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;
    var titles = root.querySelectorAll('div');
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (text(t) !== 'Failed to load plugins') continue;
      var box = t.parentElement;
      if (!box || !box.children) continue;
      for (var j = 0; j < box.children.length; j++) {
        var item = box.children[j];
        if (item === t) continue;
        var s = text(item);
        if (!s) continue;
        if (s.indexOf('\\n') !== -1 || s.indexOf('web boot:') !== -1 || s.length > 200) continue;
        if (out.indexOf(s) === -1) out.push(s);
      }
    }
    return out;
  }

  function post(path, body, doneCb) {
    fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-error-tell': '1', 'x-dsh-error-token': '__DSH_ERROR_TOKEN__' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { doneCb(j && j.ok); })
      .catch(function () { doneCb(false); });
  }

  // ---------- 加载页失败：禁用面板 ----------
  function renderDisablePanel(names) {
    if (done) return;
    done = true;
    var p = el('div', 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:420px;background:#1e1e2e;color:#e8e8f0;border:1px solid #555;border-radius:10px;padding:14px 16px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45)');
    var title = el('div', 'font-weight:600;margin-bottom:8px');
    title.textContent = 'dsh-error-tell：检测到 ' + names.length + ' 个插件加载失败';
    p.appendChild(title);
    names.forEach(function (n) {
      var row = el('div', 'display:flex;align-items:center;gap:8px;margin:4px 0');
      var label = el('span', 'flex:1;word-break:break-all');
      label.textContent = n;
      var btn = el('button', 'background:#d33;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer');
      btn.textContent = '禁用并重载';
      btn.addEventListener('click', function () {
        btn.disabled = true; btn.textContent = '禁用中…';
        post('/disable', { rowId: n }, function (ok) { if (ok) location.reload(); else { btn.disabled = false; btn.textContent = '失败，重试'; } });
      });
      row.appendChild(label);
      row.appendChild(btn);
      p.appendChild(row);
    });
    document.body.appendChild(p);
  }

  // ---------- 徽标：可拖动 ----------
  function makeDraggable(target) {
    var startX = 0, startY = 0, origLeft = 0, origTop = 0, moved = false;
    target.addEventListener('mousedown', function (e) {
      startX = e.clientX;
      startY = e.clientY;
      var r = target.getBoundingClientRect();
      origLeft = r.left;
      origTop = r.top;
      moved = false;
      function onMove(ev) {
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        if (moved) {
          target.style.left = (origLeft + dx) + 'px';
          target.style.top = (origTop + dy) + 'px';
          target.style.right = 'auto';
          target.style.bottom = 'auto';
          if (panel) positionPanel(); // 面板跟随徽标
        }
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (moved) { e.preventDefault(); target.__dragged = true; }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------- 面板定位：锚定在徽标旁（上方对齐徽标右缘，拖动时跟随） ----------
  function positionPanel() {
    if (!panel || !badge) return;
    var br = badge.getBoundingClientRect();
    var pw = panel.offsetWidth || PANEL_W;
    var ph = panel.offsetHeight || 120;
    var pad = 8;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || (document.documentElement && document.documentElement.clientWidth) || 800;
    var vh = (typeof window !== 'undefined' && window.innerHeight) || (document.documentElement && document.documentElement.clientHeight) || 600;
    var left = br.right - pw;
    if (left < pad) left = pad;
    if (left + pw > vw - pad) left = Math.max(pad, vw - pw - pad);
    var top = br.top - ph - pad;
    if (top < pad) top = br.bottom + pad;
    if (top + ph > vh - pad) top = Math.max(pad, vh - ph - pad);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function renderBadge() {
    if (done || badge) return;
    badge = el('div', 'position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;align-items:center;gap:6px;background:#1e1e2e;color:#9ecbff;border:1px solid #3a3a4a;border-radius:16px;padding:6px 12px;font:12px/1 system-ui,sans-serif;cursor:grab;box-shadow:0 4px 14px rgba(0,0,0,.4);user-select:none');
    badge.setAttribute('data-dsh-error-tell', '1');
    badge.textContent = 'err-tell …';
    badge.addEventListener('click', function () {
      if (badge.__dragged) { badge.__dragged = false; return; } // 拖动结束不展开面板
      togglePanel();
    });
    makeDraggable(badge);
    document.body.appendChild(badge);
  }

  function updateBadge(status) {
    lastStatus = status;
    if (!badge) return;
    var n = (status && status.disabled || []).filter(function (d) { return d.disabled; }).length;
    if (n > 0) {
      badge.textContent = 'err-tell ' + n + ' ⚠';
      badge.style.borderColor = '#d33';
    } else {
      badge.textContent = 'err-tell ✓';
      badge.style.borderColor = '#2a7';
    }
  }

  // 历史记录：行下追加插件功能描述 / 包名 / 失败原因（帮助使用的人排错）
  function appendDesc(container, item, rowId) {
    var name = item && (item.name || item.package) || null;
    var desc = item && item.desc || null;
    if (desc) {
      var d = el('div', 'color:#9a9ab0;font-size:11px;margin:2px 0 0;word-break:break-word');
      d.textContent = desc;
      container.appendChild(d);
    }
    if (name && name !== rowId && name !== desc) {
      var n = el('div', 'color:#6a6a80;font-size:10px;margin:1px 0 0;word-break:break-all');
      n.textContent = '包: ' + name;
      container.appendChild(n);
    }
  }
  function appendErr(container, item) {
    var e = item && item.error || null;
    if (!e) return;
    var d = el('div', 'color:#c87a6a;font-size:11px;margin:2px 0 0;word-break:break-word');
    var s = String(e);
    if (s.length > 160) s = s.slice(0, 157) + "…";
    d.textContent = '原因: ' + s;
    container.appendChild(d);
  }

  function togglePanel() {
    if (!badge) return;
    if (panel) { panel.remove(); panel = null; return; }
    panel = el('div', 'position:fixed;z-index:99998;width:340px;max-height:60vh;overflow:auto;visibility:hidden;background:#1e1e2e;color:#e8e8f0;border:1px solid #555;border-radius:10px;padding:12px 14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45)');
    panel.setAttribute('data-dsh-error-tell-panel', '1');
    var title = el('div', 'font-weight:600;margin-bottom:8px');
    title.textContent = 'dsh-error-tell';
    panel.appendChild(title);
    var st = lastStatus || { disabled: [] };
    var list = st.disabled || [];
    // 建议3：拆成「已禁用（可恢复）」与「仅记录（未禁用）」，避免面板误导
    var act = list.filter(function (d) { return d.disabled; });
    var rest = list.filter(function (d) { return !d.disabled; });
    var envIssue = !!(st.environmentIssue) || list.some(function (d) { return /-batch|-env/.test(d.source || ''); });
    if (act.length === 0 && rest.length === 0) {
      var okLine = el('div', 'color:#7bc86b;margin:6px 0');
      okLine.textContent = '✓ 没有被禁用的插件';
      panel.appendChild(okLine);
    } else {
      act.forEach(function (item) {
        var row = el('div', 'margin:6px 0');
        var line = el('div', 'display:flex;align-items:center;gap:8px');
        var label = el('span', 'flex:1;word-break:break-all');
        label.textContent = (item.rowId || item) + (item.source ? ' [' + item.source + ']' : '');
        if (item.desc || item.name) label.title = item.desc || item.name;
        var btn = el('button', 'background:#2a7;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap');
        btn.textContent = '恢复并重载';
        btn.addEventListener('click', function () {
          btn.disabled = true; btn.textContent = '恢复中…';
          post('/restore', { rowId: item.rowId || item }, function (ok) { if (ok) location.reload(); else { btn.disabled = false; btn.textContent = '失败，重试'; } });
        });
        line.appendChild(label);
        line.appendChild(btn);
        row.appendChild(line);
        appendDesc(row, item, item.rowId || item);
        appendErr(row, item);
        panel.appendChild(row);
      });
      // 全部恢复并重载（依次调用 restore，全部成功后重载）
      var allBtn = el('button', 'background:#2a7;color:#fff;border:0;border-radius:6px;padding:5px 12px;margin-top:8px;cursor:pointer;width:100%');
      allBtn.textContent = '全部恢复并重载';
      allBtn.addEventListener('click', function () {
        allBtn.disabled = true; allBtn.textContent = '恢复中…';
        var left = list.slice();
        (function next() {
          if (!left.length) return location.reload();
          var item = left.shift();
          post('/restore', { rowId: item.rowId || item }, function (ok) { if (!ok) alert('恢复失败: ' + (item.rowId || item)); next(); });
        })();
      });
      panel.appendChild(allBtn);
      if (rest.length > 0) {
        var det = el('details', 'color:#888;font-size:11px;margin-top:6px;border-top:1px solid #333;padding-top:4px');
        var sum = el('summary', 'cursor:pointer;color:#9a9ab0;font-size:11px');
        sum.textContent = '另有 ' + rest.length + ' 条仅记录（未禁用，展开查看原因）';
        det.appendChild(sum);
        rest.forEach(function (item) {
          var r2 = el('div', 'margin:4px 0 0;color:#bbb;word-break:break-word');
          r2.textContent = (item.rowId || item) + (item.source ? ' [' + item.source + ']' : '');
          appendDesc(r2, item, item.rowId || item);
          appendErr(r2, item);
          det.appendChild(r2);
        });
        panel.appendChild(det);
      }
      if (envIssue) {
        var warnLine = el('div', 'color:#e5a50a;font-size:11px;margin-top:6px');
        warnLine.textContent = '⚠ 最近失败疑似环境问题（端口占用/多实例等），已自动跳过禁用';
        panel.appendChild(warnLine);
      }
    }
    var meta = el('div', 'color:#888;font-size:11px;margin-top:8px;border-top:1px solid #333;padding-top:6px');
    meta.textContent = '端点: ' + (st.ok === false ? '不可用' : '正常') + ' | 历史记录: ' + (st.total || 0);
    panel.appendChild(meta);
    document.body.appendChild(panel);
    positionPanel();
    panel.style.visibility = 'visible';
  }

  function fetchStatus() {
    if (statusTries >= 3) return;
    statusTries += 1;
    fetch(API + '/status', { headers: HDR })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (j && typeof j.ok === 'boolean') { updateBadge(j); if (!j.ok) statusTries = 99; } })
      .catch(function () { updateBadge({ ok: false, disabled: [] }); });
  }

  function scan() {
    if (done || !document.body) return;
    var names = extractFailedNames(document);
    if (names.length) { renderDisablePanel(names); stop(); return; }
    renderBadge();
    setTimeout(fetchStatus, 1000);
  }

  function stop() { if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; } }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(scan, 400); });
  } else { setTimeout(scan, 400); }
  try { observer = new MutationObserver(scan); observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  setTimeout(scan, 2000);
})();
`;
