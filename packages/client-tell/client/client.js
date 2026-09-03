// dsh-error-tell — dsh web 设置页「错误看门狗」分区（客户端模块，官方 __ModuleLoader__ 协议）。
// 数据来自宿主端点 /api/error-tell/*；每页 token 由注入脚本暴露在 window.__DSH_ERROR_TELL__。
window.__ModuleLoader__.load({
  id: '@dsh-error-tell/client-tell',
  factory: function (require) {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');
    var API = '/api/error-tell';

    // ---------- 基础工具 ----------
    function getToken() {
      try { var g = window.__DSH_ERROR_TELL__; return (g && g.token) || ''; } catch (e) { return ''; }
    }
    function hdr(json) {
      var h = { 'x-dsh-error-tell': '1', 'x-dsh-error-token': getToken() };
      if (json) h['content-type'] = 'application/json';
      return h;
    }
    function api(path, opts) {
      return fetch(API + path, opts).then(function (r) { return r.json().catch(function () { return {}; }); });
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    // ---------- 样式（一次性注入，class 前缀 et-） ----------
    var STYLE_ID = "dsh-error-tell-settings-style";
    var STYLE = [
      ".et-wrap{font:13px/1.6 system-ui,sans-serif;color:inherit;max-width:860px;padding:2px 4px 18px}",
      ".et-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 10px}",
      ".et-title{font-size:15px;font-weight:600}",
      ".et-muted{opacity:.62;font-size:12px}",
      ".et-btn{background:transparent;border:1px solid currentColor;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;opacity:.85}",
      ".et-btn:hover{opacity:1}",
      ".et-btn:disabled{opacity:.4;cursor:default}",
      ".et-btn-danger{color:#c43e3e}",
      ".et-btn-ok{color:#1f8a4c}",
      ".et-chip{display:inline-block;border-radius:10px;padding:1px 8px;font-size:11px;border:1px solid currentColor;white-space:nowrap}",
      ".et-chip-off{color:#8a8a8a}",
      ".et-chip-bad{color:#c43e3e}",
      ".et-chip-on{color:#1f8a4c}",
      ".et-chip-warn{color:#b8860b}",
      ".et-row{border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:7px 10px;margin:6px 0}",
      ".et-row-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".et-name{font-weight:600;word-break:break-all;flex:1;min-width:180px}",
      ".et-desc{opacity:.7;font-size:12px;word-break:break-word;margin-top:2px}",
      ".et-meta{opacity:.55;font-size:11px;margin-top:2px;word-break:break-word}",
      ".et-group{font-weight:700;opacity:.75;margin:12px 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase}",
      ".et-err{color:#c43e3e;font-size:12px;margin:6px 0}",
      ".et-flash{color:#1f8a4c;font-size:12px;margin:6px 0}",
      ".et-card{border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:8px 12px;margin:12px 0}",
      ".et-card h4{margin:0 0 6px;font-size:13px}",
      ".et-btn-mini{padding:1px 8px;font-size:12px}",
      ".et-summary{cursor:pointer;opacity:.75;font-size:12px}",
      ".et-spin{opacity:.6;padding:14px 0}",
      ".et-tabs{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 10px;border-bottom:1px solid rgba(128,128,128,.28);padding:0 0 6px}",
      ".et-tab{background:transparent;border:1px solid transparent;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;padding:5px 12px;cursor:pointer;font:inherit;opacity:.72;white-space:nowrap}",
      ".et-tab:hover{opacity:1}",
      ".et-tab-active{opacity:1;border:1px solid rgba(128,128,128,.35);border-bottom-color:currentColor;font-weight:600}",
      ".et-content{min-height:120px}"
    ].join("\n");
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var s = el('style');
      s.id = STYLE_ID;
      s.setAttribute('data-plugin', '@dsh-error-tell/client-tell');
      s.textContent = STYLE;
      (document.head || document.documentElement).appendChild(s);
    }

    // ---------- 状态展示 ----------
    function stateChip(row) {
      if (row.disabled) return { text: row.managed ? '已禁用(本工具)' : '已禁用(手动配置)', cls: 'et-chip et-chip-off' };
      if (row.state === 'failed') return { text: '挂载失败', cls: 'et-chip et-chip-bad' };
      if (row.state === 'active') return { text: '运行中', cls: 'et-chip et-chip-on' };
      return { text: '未挂载', cls: 'et-chip et-chip-warn' };
    }
    function fmtTime(iso) {
      try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso || ""); }
    }
    function actionBtn(row, onDone, onFail) {
      var btn;
      if (row.guard) {
        var sp = el('span', 'et-muted', '守护行，不可操作');
        return sp;
      }
      if (row.disabled && row.managed) {
        btn = el('button', 'et-btn et-btn-ok et-btn-mini', '恢复');
        btn.title = '移除 managed 禁用（写入 home patch），热重载 1-2 秒生效';
        btn.onclick = function () { doAction('restore', row.rowId, btn, onDone, onFail); };
        return btn;
      }
      if (row.disabled && !row.managed) {
        var h2 = el('span', 'et-muted', '补丁手动禁用，请编辑 cordis.patch.yml');
        return h2;
      }
      if (row.protected) {
        var p = el('button', 'et-btn et-btn-danger et-btn-mini', '禁用');
        p.disabled = true;
        p.title = '受保护核心服务（PROTECTED_IDS），拒绝自动/手动禁用';
        return p;
      }
      btn = el('button', 'et-btn et-btn-danger et-btn-mini', row.state === 'failed' ? '禁用' : '禁用');
      btn.title = row.state === 'failed' ? '该行挂载失败；禁用后重启不再加载' : '写入 managed 禁用（本工具可随时恢复）';
      btn.onclick = function () { doAction('disable', row.rowId, btn, onDone, onFail); };
      return btn;
    }
    // 分类分栏：官方 / 第三方 / 用户层（kind 由宿主 /plugins 提供）
    var KIND_ORDER = ['official', 'third', 'user'];
    var KIND_TITLE = {
      official: '官方插件（@deepseek-ai / cordis:）',
      third: '第三方插件（社区包）'
    };
    function renderRow(box, row, stMap, onDone, onFail) {
      if (row.group) {
        box.appendChild(el('div', 'et-group', '组 ' + row.rowId + (row.name && row.name !== row.rowId ? ' · ' + row.name : '')));
        return;
      }
      var card = el('div', 'et-row');
      var main = el('div', 'et-row-main');
      var chip = stateChip(row);
      var name = el('span', 'et-name', row.rowId);
      main.appendChild(name);
      main.appendChild(el('span', chip.cls, chip.text));
      var st = stMap[row.rowId];
      if (st && !st.disabled) main.appendChild(el('span', 'et-chip et-chip-warn', '曾失败 x' + (st.failCount || 1) + ' [' + (st.source || '?') + ']'));
      main.appendChild(actionBtn(row, onDone, onFail));
      card.appendChild(main);
      var descLine = row.desc || row.name;
      if (descLine && descLine !== row.rowId) card.appendChild(el('div', 'et-desc', descLine));
      var metaBits = [];
      if (row.name && row.name !== row.rowId) metaBits.push('包: ' + row.name);
      if (row.state === 'failed') metaBits.push('状态: 挂载失败（等待处理或禁用）');
      if (metaBits.length) card.appendChild(el('div', 'et-meta', metaBits.join(' · ')));
      box.appendChild(card);
    }
    function buildPlugins(list, stMap, onDone, onFail) {
      var box = el('div');
      var buckets = { official: [], third: [] };
      list.forEach(function (r) {
        var k = kindOf(r);
        buckets[k].push(r);
      });
      var any = false;
      KIND_ORDER.forEach(function (k) {
        var rows = buckets[k];
        if (!rows.length) return;
        any = true;
        box.appendChild(el('div', 'et-group', KIND_TITLE[k] + '（' + rows.length + '）'));
        rows.forEach(function (row) { renderRow(box, row, stMap, onDone, onFail); });
      });
      if (!any) box.appendChild(el('div', 'et-muted', '（没有可显示的插件行）'));
      return box;
    }
    function buildHistory(st, onDone, onFail) {
      var card = el('div', 'et-card');
      var h4 = el('h4', null, '看门狗历史');
      card.appendChild(h4);
      var list = (st && st.disabled) || [];
      var env = !!(st && st.environmentIssue);
      if (env) card.appendChild(el('div', 'et-err', '⚠ 最近失败疑似环境问题（端口占用/多实例等），已自动跳过禁用'));
      if (!list.length) {
        card.appendChild(el('div', 'et-muted', '暂无记录（总历史 ' + (st && st.total || 0) + ' 条，完整列表见 CLI: dsh-error-tell status）'));
        return card;
      }
      list.forEach(function (it) {
        var row = el('div', 'et-row');
        var main = el('div', 'et-row-main');
        main.appendChild(el('span', 'et-name', it.rowId + ' [' + (it.source || '?') + ']'));
        if (it.disabled) {
          var b = el('button', 'et-btn et-btn-ok et-btn-mini', '恢复');
          b.onclick = function () { doAction('restore', it.rowId, b, onDone, onFail); };
          main.appendChild(b);
        } else {
          main.appendChild(el('span', 'et-chip et-chip-warn', '仅记录 · 失败 ' + (it.failCount || 1) + ' 次'));
        }
        row.appendChild(main);
        if (it.desc) row.appendChild(el('div', 'et-desc', it.desc));
        if (it.error) row.appendChild(el('div', 'et-meta', '原因: ' + it.error));
        if (it.at) row.appendChild(el('div', 'et-meta', '时间: ' + fmtTime(it.at)));
        card.appendChild(row);
      });
      card.appendChild(el('div', 'et-muted', '总历史 ' + (st && st.total || 0) + ' 条 · 端点 ' + (st && st.ok === false ? '不可用' : '正常')));
      return card;
    }

    // ---------- 页签小页面导航与渲染 ----------
    var current = null; // { root, flashEl, sumEl, tabEl, contentEl, plugins, status, stMap, tab, busy }
    var TABS = [
      { key: 'all', label: '全部插件' },
      { key: 'official', label: '官方插件' },
      { key: 'third', label: '第三方插件' },
      { key: 'history', label: '看门狗历史' }
    ];
    function flash(text, isErr) {
      if (!current) return;
      current.flashEl.textContent = text || '';
      current.flashEl.className = isErr ? 'et-err' : 'et-flash';
      clearTimeout(current._ft);
      current._ft = setTimeout(function () { current.flashEl.textContent = ''; }, 8000);
    }
    function kindOf(row) {
      return row.kind === 'official' ? 'official' : 'third';
    }
    function doAction(kind, rowId, btn, onDone, onFail) {
      if (!getToken()) { onFail('页面缺少访问令牌——请刷新页面后重试'); return; }
      var wasDisabled = btn.disabled;
      var oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = kind === 'disable' ? '禁用中…' : '恢复中…';
      api(kind === 'disable' ? '/disable' : '/restore', {
        method: 'POST',
        headers: hdr(true),
        body: JSON.stringify({ rowId: rowId })
      }).then(function (j) {
        btn.disabled = wasDisabled;
        btn.textContent = oldText;
        if (j && j.ok) {
          flash((kind === 'disable' ? '已禁用 ' : '已恢复 ') + rowId + '（热重载 1-2 秒生效）', false);
          if (onDone) onDone(rowId);
        } else {
          onFail('操作失败：' + (j && j.error || '未知错误'));
        }
      }).catch(function (e) {
        btn.disabled = wasDisabled;
        btn.textContent = oldText;
        onFail('网络错误：' + (e && e.message || e));
      });
    }
    function doneCb() { setTimeout(refresh, 1400); }
    function errCb(m) { flash(m, true); }
    // 顶部页签：点击跳转到对应小页面
    function renderTabs() {
      if (!current || !current.tabEl) return;
      current.tabEl.innerHTML = '';
      var rows = current.plugins || [];
      var activeHist = (current.status && current.status.disabled || []).length;
      TABS.forEach(function (t) {
        var n = t.key === 'all' ? rows.length : (t.key === 'history' ? activeHist : rows.filter(function (x) { return kindOf(x) === t.key; }).length);
        var b = el('button', 'et-tab' + (current.tab === t.key ? ' et-tab-active' : ''), t.label + '（' + n + '）');
        b.onclick = function () { current.tab = t.key; render(); };
        current.tabEl.appendChild(b);
      });
    }
    function renderKindPage(kind) {
      var box = el('div');
      var rows = (current.plugins || []).filter(function (x) { return kindOf(x) === kind; });
      var groups = rows.filter(function (x) { return x.group; });
      var items = rows.filter(function (x) { return !x.group; });
      if (!rows.length) { box.appendChild(el('div', 'et-muted', '（该分类暂无插件）')); return box; }
      groups.forEach(function (g) { renderRow(box, g, current.stMap || {}, doneCb, errCb); });
      items.forEach(function (it) { renderRow(box, it, current.stMap || {}, doneCb, errCb); });
      return box;
    }
    function render() {
      if (!current) return;
      renderTabs();
      current.contentEl.innerHTML = '';
      var rows = current.plugins || [];
      var stMap = current.stMap || {};
      if (current.tab === 'history') {
        current.contentEl.appendChild(buildHistory(current.status || {}, doneCb, errCb));
      } else if (current.tab === 'all') {
        current.contentEl.appendChild(buildPlugins(rows, stMap, doneCb, errCb));
      } else {
        current.contentEl.appendChild(renderKindPage(current.tab));
      }
      var off = rows.filter(function (r) { return r.disabled; }).length;
      var bad = rows.filter(function (r) { return r.state === 'failed' && !r.disabled; }).length;
      current.sumEl.textContent = '已禁用 ' + off + ' · 挂载失败 ' + bad + ' · 总历史 ' + (current.status && current.status.total || 0);
    }
    function refresh() {
      if (!current || current.busy) return;
      current.busy = true;
      flash('读取中…', false);
      Promise.all([
        api('/plugins', { headers: hdr(false) }),
        api('/status', { headers: hdr(false) })
      ]).then(function (res) {
        current.busy = false;
        var pj = res[0] || {}, sj = res[1] || {};
        if (!pj.ok || !sj.ok) {
          flash('端点读取失败：' + ((pj.error || sj.error) || '未知') + '（token 缺失或服务未就绪）', true);
        }
        current.plugins = pj.plugins || [];
        current.status = sj;
        current.stMap = {};
        (sj.disabled || []).forEach(function (e) { current.stMap[e.rowId] = e; });
        render();
      }).catch(function (e) {
        current.busy = false;
        flash('读取失败：' + (e && e.message || e), true);
      });
    }
    function mountUI(root) {
      ensureStyle();
      root.innerHTML = '';
      var wrap = el('div', 'et-wrap');
      var head = el('div', 'et-head');
      head.appendChild(el('span', 'et-title', 'dsh-error-tell 错误看门狗'));
      var sum = el('span', 'et-muted', '');
      head.appendChild(sum);
      var rbtn = el('button', 'et-btn et-btn-mini', '刷新');
      rbtn.onclick = function () { refresh(); };
      head.appendChild(rbtn);
      wrap.appendChild(head);
      var fl = el('div', '');
      wrap.appendChild(fl);
      wrap.appendChild(el('div', 'et-muted', '说明：官方 = @deepseek-ai/cordis: 包行；第三方 = 其余社区包行（补丁里配置/禁用的行仍按包归属归入对应分类）。禁用/恢复写入 home patch（managed 段），热重载约 1-2 秒生效；核心服务与看门狗自身受保护。'));
      var tabEl = el('div', 'et-tabs');
      wrap.appendChild(tabEl);
      var contentEl = el('div', 'et-content');
      wrap.appendChild(contentEl);
      root.appendChild(wrap);
      current = { root: wrap, flashEl: fl, sumEl: sum, tabEl: tabEl, contentEl: contentEl, plugins: [], status: null, stMap: {}, tab: 'all', busy: false };
      if (!getToken()) flash('警告：页面未注入访问令牌——请刷新页面后重试', true);
      refresh();
    }

    // ---------- React 外壳 ----------
    function SectionBody() {
      var ref = react.useRef(null);
      react.useEffect(function () {
        if (ref.current) mountUI(ref.current);
        return function () { current = null; };
      }, []);
      return react.createElement('div', { ref: ref, style: { width: '100%' } });
    }
    var name = "dsh-error-tell-settings";
    var inject = ["slots"];
    function apply(ctx) {
      if (!ctx || !ctx.slots) {
        console.warn('[dsh-error-tell] ctx.slots 不可用，设置分区未注册');
        return;
      }
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-error-tell',
            order: 41,
            label: function () { return '错误看门狗'; }
          }, function () { return react.createElement(SectionBody, {}); });
        });
        console.info('[dsh-error-tell] 设置分区已注册（设置 → 错误看门狗）');
      } catch (e) {
        console.warn('[dsh-error-tell] 设置分区注册失败: ' + (e && e.message || e));
      }
    }
    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
