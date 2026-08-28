import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECT_SCRIPT } from '../packages/client-tell/src/inject-script.js';

function element(tag) {
  const handlers = {};
  return {
    tagName: tag, textContent: '', title: '', style: {}, children: [], parentElement: null,
    offsetWidth: 340, offsetHeight: 120,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    _handlers: handlers,
    remove() { const p = this.parentElement; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } this.parentElement = null; },
    click() { (handlers.click || []).forEach(fn => fn()); },
    getBoundingClientRect() {
      const left = parseFloat(this.style.left) || 0;
      const top = parseFloat(this.style.top) || 0;
      const width = 100, height = 30;
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
    setAttribute() {}
  };
}

// 假 DOM 的 textContent 不聚合子节点，需要递归拼接
function deepText(el) {
  return el.textContent + (el.children || []).map(deepText).join('');
}

function makeDom() {
  const root = element('div');
  root.querySelectorAll = () => [];
  return { root };
}

function makeDoc(dom) {
  const listeners = {};
  return {
    readyState: 'complete', documentElement: {}, body: { children: [], appendChild(c) { this.children.push(c); c.parentElement = this; } },
    createElement: (t2) => element(t2),
    querySelectorAll: () => dom.root.querySelectorAll(),
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { const a = listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  };
}

test('注入脚本：加载页失败时渲染禁用按钮面板', async () => {
  // 构造失败卡片 DOM
  const title = element('div');
  title.textContent = 'Failed to load plugins';
  const box = element('div');
  box.appendChild(title);
  const it1 = element('div'); it1.textContent = '@x/bad-plugin'; box.appendChild(it1);
  const it2 = element('div'); it2.textContent = 'another:bad'; box.appendChild(it2);
  const it3 = element('div'); it3.textContent = 'web boot: 多行错误\nline2'; box.appendChild(it3);
  const root = element('div'); root.appendChild(box);
  root.querySelectorAll = () => [title];
  const doc = makeDoc({ root });
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({ ok: false }) }); },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 700));
  const panel = doc.body.children[0];
  assert.ok(panel, '禁用面板已渲染');
  assert.equal(panel.children.length, 3, '标题 + 2 行（多行错误跳过）');
  assert.equal(panel.children[1].children[1].textContent, '禁用并重载');
  assert.equal(panel.children[2].children[0].textContent, 'another:bad');
});

test('注入脚本：正常页面常驻徽标，有禁用时点击展开恢复面板，面板锚定徽标旁', async () => {
  const dom = makeDom();
  const doc = makeDoc(dom);
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: (url) => {
      if (url.includes('/status')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [{ rowId: 'x-bad', source: 'runtime-guard', disabled: true }, { rowId: 'y-note', source: 'runtime-guard-protected', disabled: false }], total: 3, environmentIssue: false }) });
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 2600));
  const badge = doc.body.children[0];
  assert.ok(badge, '徽标已渲染');
  assert.ok(badge.textContent.includes('err-tell'), '徽标文本');
  assert.ok(badge.textContent.includes('1'), '徽标显示禁用计数');
  badge.click();
  const panel = doc.body.children[1];
  assert.ok(panel, '点击后展开面板');
  const row = panel.children[1];
  const line = row.children[0];
  assert.ok(line.children[0].textContent.includes('x-bad'), '面板列出被禁用行: ' + line.children[0].textContent);
  assert.equal(line.children[1].textContent, '恢复并重载');
  assert.equal(panel.children[2].textContent, '全部恢复并重载', '面板含全部恢复按钮');
  assert.ok(panel.children.some(ch => deepText(ch).includes('端点')), '面板含端点状态');
  assert.ok(panel.children.some(ch => deepText(ch).includes('条仅记录')), '面板含仅记录折叠行');
  assert.equal(panel.style.left, '8px', '面板左缘贴边');
  assert.equal(panel.style.top, '38px', '面板锚定在徽标上方');
});

test('注入脚本：拖动徽标后点击不展开面板（拖拽 vs 点击区分）', async () => {
  const dom = makeDom();
  const doc = makeDoc(dom);
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [], total: 0 }) }),
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 2600));
  const badge = doc.body.children[0];
  assert.ok(badge, '徽标已渲染');
  // 模拟拖拽：mousedown → mousemove(>3px) → mouseup
  const md = badge._handlers.mousedown[0];
  const ev = { clientX: 100, clientY: 100, preventDefault() {} };
  md(ev);
  const mm = doc.listeners.mousemove[0];
  mm({ clientX: 160, clientY: 120 });
  const mu = doc.listeners.mouseup[0];
  mu({ clientX: 160, clientY: 120 });
  badge.click();
  assert.equal(doc.body.children.length, 1, '拖拽后点击不展开面板');
  // 再点一次（非拖拽）应展开
  badge.click();
  assert.equal(doc.body.children.length, 2, '普通点击展开面板');
});

test('注入脚本：面板打开时拖动徽标，面板跟随移动', async () => {
  const dom = makeDom();
  const doc = makeDoc(dom);
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [], total: 0 }) }),
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 2600));
  const badge = doc.body.children[0];
  badge.click(); // 打开面板
  const panel = doc.body.children[1];
  assert.equal(panel.style.top, '38px', '初始锚定在徽标上方');
  const md = badge._handlers.mousedown[0];
  md({ clientX: 100, clientY: 100, preventDefault() {} });
  doc.listeners.mousemove[0]({ clientX: 200, clientY: 150 });
  assert.equal(badge.style.left, '100px');
  assert.equal(badge.style.top, '50px');
  assert.equal(panel.style.top, '88px', '面板跟随徽标下移');
  assert.equal(panel.style.left, '8px', '面板保持贴边');
  doc.listeners.mouseup[0]({ clientX: 200, clientY: 150 });
});

test('注入脚本：全部恢复依次调用 restore 并重载', async () => {
  const dom = makeDom();
  const doc = makeDoc(dom);
  let reloaded = false;
  const posts = [];
  const sandbox = {
    document: doc, location: { reload() { reloaded = true; } }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: (url, opts) => {
      if (url.includes('/status')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [{ rowId: 'a-bad', disabled: true }, { rowId: 'b-bad', disabled: true }], total: 2 }) });
      if (url.includes('/restore')) { posts.push(JSON.parse(opts.body).rowId); return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 2600));
  const badge = doc.body.children[0];
  badge.click();
  const panel = doc.body.children[1];
  const allBtn = panel.children[panel.children.length - 2]; // meta 前一个
  assert.equal(allBtn.textContent, '全部恢复并重载');
  allBtn.click();
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(posts.sort(), ['a-bad', 'b-bad'], '依次调用 restore');
  assert.ok(reloaded, '全部成功后重载');
});

test('注入脚本：历史记录显示插件功能描述、包名与失败原因', async () => {
  const dom = makeDom();
  const doc = makeDoc(dom);
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [
      { rowId: 'x-bad', package: 'some-pkg', name: 'some-pkg', desc: '这是插件功能说明', error: 'apply 出错', source: 'runtime-guard', disabled: true },
      { rowId: 'y-note', package: 'note-pkg', name: 'note-pkg', desc: '记录用插件说明', error: '保护名单未禁用', source: 'runtime-guard-protected', disabled: false }
    ], total: 2, environmentIssue: false }) }),
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 2600));
  const badge = doc.body.children[0];
  badge.click();
  const panel = doc.body.children[1];
  const row = panel.children[1];
  assert.ok(deepText(row).includes('这是插件功能说明'), '已禁用行显示功能描述');
  assert.ok(deepText(row).includes('some-pkg'), '已禁用行显示包名');
  assert.ok(deepText(row).includes('原因: apply 出错'), '已禁用行显示失败原因');
  const det = panel.children[3];
  assert.ok(det, '仅记录折叠区存在');
  assert.ok(deepText(det).includes('另有 1 条仅记录'), '仅记录折叠摘要');
  assert.ok(deepText(det).includes('记录用插件说明'), '仅记录行显示功能描述');
  assert.ok(deepText(det).includes('原因: 保护名单未禁用'), '仅记录行显示原因');
});

test('注入脚本：无禁用时徽标显示正常，面板显示无异常', async () => {
  const dom = makeDom();
  const doc = makeDoc(dom);
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [], total: 0 }) }),
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 2600));
  const badge = doc.body.children[0];
  assert.ok(badge, '徽标已渲染');
  assert.ok(badge.textContent.includes('✓'), '无禁用显示 ✓');
  badge.click();
  const panel = doc.body.children[1];
  assert.ok(panel, '面板已展开');
  assert.ok(panel.children[1].textContent.includes('没有被禁用的插件'), '面板显示无异常');
});
