import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECT_SCRIPT } from '../packages/client-tell/src/inject-script.js';

function element(tag) {
  return {
    tagName: tag, textContent: '', style: {}, children: [], parentElement: null,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    addEventListener() {}, setAttribute() {},
    click() { const h = this._click; if (h) h(); }
  };
}

function makeDom(names, errorText) {
  const title = element('div');
  title.textContent = 'Failed to load plugins';
  const box = element('div');
  box.appendChild(title);
  for (const n of names) { const it = element('div'); it.textContent = n; box.appendChild(it); }
  if (errorText) { const it = element('div'); it.textContent = errorText; box.appendChild(it); }
  const card = element('div'); card.appendChild(box);
  const root = element('div'); root.appendChild(card);
  root.querySelectorAll = () => [title];
  return { root, title, box };
}

test('注入脚本：提取失败插件名 → 渲染按钮', async () => {
  const dom = makeDom(['@x/bad-plugin', 'another:bad'], 'web boot: 2 entries did not activate\n多行错误');
  const doc = {
    readyState: 'complete',
    documentElement: {}, body: { children: [], appendChild(c) { this.children.push(c); c.parentElement = this; } },
    createElement: (t) => element(t),
    querySelectorAll: () => dom.root.querySelectorAll(),
    addEventListener() {}
  };
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 700));
  const panel = doc.body.children[0];
  assert.ok(panel, '面板已渲染');
  assert.equal(panel.children.length, 4, '标题 + 2 个行（多行错误被跳过）+ 全部禁用按钮');
  const row0 = panel.children[1];
  assert.equal(row0.children[0].textContent, '@x/bad-plugin');
  assert.equal(row0.children[1].textContent, '禁用并重载');
  const row1 = panel.children[2];
  assert.equal(row1.children[0].textContent, 'another:bad');
  assert.equal(panel.children[3].textContent, '全部禁用并重载');
});
test('注入脚本：正常页面且有被禁用插件时渲染恢复面板', async () => {
  const dom = makeDom([], null);
  const doc = {
    readyState: 'complete', documentElement: {}, body: { children: [], appendChild(c) { this.children.push(c); c.parentElement = this; } },
    createElement: (t2) => element(t2),
    querySelectorAll: () => dom.root.querySelectorAll(),
    addEventListener() {}
  };
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch: (url) => {
      if (url.includes('/status')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, disabled: [{ rowId: 'x-bad', source: 'runtime-guard' }] }) });
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r2 => setTimeout(r2, 2600));
  const panel = doc.body.children[0];
  assert.ok(panel, '恢复面板已渲染');
  assert.ok(panel.children[0].textContent.includes('被禁用'), '标题含禁用信息');
  const row = panel.children[1];
  assert.ok(row.children[0].textContent.includes('x-bad'), '列出被禁用行');
  assert.equal(row.children[1].textContent, '恢复并重载');
});
test('注入脚本：无失败时不渲染面板', async () => {
  const dom = makeDom([], null);
  const doc = {
    readyState: 'complete', documentElement: {}, body: { children: [], appendChild(c) { this.children.push(c); } },
    createElement: (t) => element(t),
    querySelectorAll: () => dom.root.querySelectorAll(),
    addEventListener() {}
  };
  const sandbox = {
    document: doc, location: { reload() {} }, alert() {},
    MutationObserver: class { observe() {} },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({ ok: false }) }); },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECT_SCRIPT, sandbox);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(doc.body.children.length, 0, '无失败时不渲染面板');
});
