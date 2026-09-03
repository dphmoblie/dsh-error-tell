import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUNDLE = readFileSync(fileURLToPath(new URL('../packages/client-tell/client/client.js', import.meta.url)), 'utf8');

function fakeReact() {
  return {
    createElement(type, props) { return { type, props: props || {} }; },
    useRef(init) { return { current: init }; },
    useEffect() {},
    useState(init) { return [typeof init === 'function' ? init() : init, function () {}]; }
  };
}

function loadBundle() {
  let handoff = null;
  const logs = [];
  const sandbox = {
    window: null,
    console: { info: function (m) { logs.push(m); }, warn: function (m) { logs.push(m); } },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); },
    __ModuleLoader__: { load(h) { handoff = h; } },
    document: { createElement() { return {}; }, getElementById() { return null; }, head: { appendChild() {} } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE, sandbox);
  assert.ok(handoff, 'bundle 调用了 __ModuleLoader__.load');
  return { handoff, logs };
}
test('client 模块：__ModuleLoader__ 注册 + 导出 name/inject/apply', () => {
  const { handoff } = loadBundle();
  assert.equal(handoff.id, '@dsh-error-tell/client-tell');
  const react = fakeReact();
  const exportsObj = handoff.factory(function (spec) {
    if (spec === 'react') return react;
    throw new Error('unexpected require: ' + spec);
  });
  assert.equal(exportsObj.name, 'dsh-error-tell-settings');
  assert.deepEqual(Array.from(exportsObj.inject), ['slots']); // vm realm 数组 → 宿主数组再比较
  assert.equal(typeof exportsObj.apply, 'function');
});

test('client 模块：apply 注册 settings.section（错误看门狗分区）', () => {
  const { handoff } = loadBundle();
  const react = fakeReact();
  const exportsObj = handoff.factory(function (spec) {
    if (spec === 'react') return react;
    throw new Error('unexpected require: ' + spec);
  });
  const injects = [];
  const regs = [];
  const ctx = {
    slots: {
      inject(key, cb) { injects.push({ key, cb }); return function () {}; },
      register(opts, content) { regs.push({ opts, content }); return function () {}; }
    }
  };
  exportsObj.apply(ctx);
  const hit = injects.find(function (i) { return i.key === 'settings.section'; });
  assert.ok(hit, '等待 settings.section 座位声明');
  const off = hit.cb();
  assert.equal(typeof off, 'function', '注册返回注销函数');
  assert.equal(regs.length, 1);
  const r = regs[0];
  assert.equal(r.opts.name, 'settings.section');
  assert.equal(r.opts.id, 'dsh-error-tell');
  assert.equal(typeof r.opts.label, 'function');
  assert.ok(String(r.opts.label()).length > 0, '分区标签非空');
  const el0 = r.content();
  assert.ok(el0 && el0.type, '内容为 React 元素');
});

test('client 模块：ctx.slots 缺失时优雅降级不抛错', () => {
  const { handoff } = loadBundle();
  const react = fakeReact();
  const exportsObj = handoff.factory(function (spec) {
    if (spec === 'react') return react;
    throw new Error('unexpected require: ' + spec);
  });
  assert.doesNotThrow(function () { exportsObj.apply({}); });
});
