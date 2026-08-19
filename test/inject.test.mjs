import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECT_SCRIPT } from '../packages/client-tell/src/inject-script.js';

function element(tag) {
  const handlers = {};
  return {
    tagName: tag, textContent: '', style: {}, children: [], parentElement: null,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    remove() { const p = this.parentElement; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } this.parentElement = null; },
    click() { (handlers.click || []).forEach(fn => fn()); },
    setAttribute() {}
  };
}

function makeDom() {
  const root = element('div');
  root.querySelectorAll = () => [];
  return { root };
}

function makeDoc(dom) {
  return {
    readyState: 'complete', documentElement: {}, body: { children: [], appendChild(c) { this.children.push(c); c.parentElement = this; } },
    createElement: (t2) => element(t2),
    querySelectorAll: () => dom.root.querySelectorAll(),
    addEventListener() {}
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

test('注入脚本：正常页面常驻徽标，有禁用时点击展开恢复面板', async () => {
  const dom = makeDom();
  const doc = makeDoc(dom);
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: (url) => {
      if (url.includes('/status')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [{ rowId: 'x-bad', source: 'runtime-guard' }], total: 3 }) });
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
  const rowText = panel.children[1].children[0].textContent;
  assert.ok(rowText.includes('x-bad'), '面板列出被禁用行: ' + rowText);
  assert.equal(panel.children[1].children[1].textContent, '恢复并重载');
  assert.ok(panel.children[2].textContent.includes('端点'), '面板含端点状态');
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
