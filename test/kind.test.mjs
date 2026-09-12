import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKindResolver, isAllowedOrigin } from '../packages/client-tell/src/host.mjs';

// 布局模拟：dsh 发行目录 @deepseek-ai/dsh 自带 node_modules；profile 另外装第三方包
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'det-kind2-'));
  const dshDir = join(base, 'node_modules', '@deepseek-ai', 'dsh');
  const dshNodeModules = join(dshDir, 'node_modules');
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }));
  // dsh 发行目录内部的非前缀官方包（锚点在发行目录内时可解析到）
  mkdirSync(join(dshNodeModules, 'internal-official'), { recursive: true });
  writeFileSync(join(dshNodeModules, 'internal-official', 'package.json'), JSON.stringify({ name: 'internal-official' }));
  // profile 安装的第三方包
  mkdirSync(join(base, 'node_modules', 'dshmarket'), { recursive: true });
  writeFileSync(join(base, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket' }));
  const scoped = join(base, 'node_modules', '@user', 'thing');
  mkdirSync(scoped, { recursive: true });
  writeFileSync(join(scoped, 'package.json'), JSON.stringify({ name: '@user/thing' }));
  return { base, dshNodeModules };
}

test('makeKindResolver：profile 锚点（真实场景）——前缀快速通道与第三方', () => {
  const f = fixture();
  try {
    const kindOf = makeKindResolver([f.base]);
    assert.equal(kindOf('@deepseek-ai/dsh-goal'), 'official');
    assert.equal(kindOf('@deepseek-ai/dsh-web-app'), 'official');
    assert.equal(kindOf('cordis:include'), 'official');
    assert.equal(kindOf('dshmarket'), 'third');
    assert.equal(kindOf('@user/thing'), 'third');
    assert.equal(kindOf('@dsh-error-tell/client-tell'), 'third');
    assert.equal(kindOf('./custom-bash.mjs'), 'third');
    assert.equal(kindOf('no-such-pkg-xyz'), 'third');
    assert.equal(kindOf(null), 'third');
    assert.equal(kindOf(''), 'third');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('makeKindResolver：发行目录内可解析的非前缀包按位置判为 official', () => {
  const f = fixture();
  try {
    // 锚点落在 dsh 自带 node_modules 内（自包含安装/内嵌场景）：非 @deepseek-ai 前缀也能按位置识别
    const kindOf = makeKindResolver([f.dshNodeModules, f.base]);
    assert.equal(kindOf('internal-official'), 'official');
    assert.equal(kindOf('dshmarket'), 'third');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('makeKindResolver：找不到 dsh 发行目录时退化为前缀规则（不抛错）', () => {
  const kindOf = makeKindResolver(['.']);
  assert.equal(kindOf('@deepseek-ai/dsh-base'), 'official');
  assert.equal(kindOf('dshmarket'), 'third');
});

// ---------- P2-18：端点来源校验 ----------
test('isAllowedOrigin：回环来源放行，外部来源拒绝，缺失头部放行（由 token 兜底）', () => {
  const req = (headers) => ({ headers });
  assert.equal(isAllowedOrigin(req({ origin: 'http://127.0.0.1:3080' })), true);
  assert.equal(isAllowedOrigin(req({ origin: 'http://localhost:3080' })), true);
  assert.equal(isAllowedOrigin(req({ origin: 'http://[::1]:3080' })), true);
  assert.equal(isAllowedOrigin(req({ referer: 'http://127.0.0.1:3080/page' })), true);

  assert.equal(isAllowedOrigin(req({ origin: 'https://evil.example' })), false, '外部来源必须拒绝');
  assert.equal(isAllowedOrigin(req({ origin: 'http://192.168.1.9:3080' })), false, '局域网其他主机也拒绝');
  assert.equal(isAllowedOrigin(req({ origin: 'not a url' })), false, '无法解析的来源拒绝');

  assert.equal(isAllowedOrigin(req({})), true, '缺失 Origin/Referer 时放行（curl/e2e 场景，token 仍是主防线）');
  assert.equal(isAllowedOrigin(undefined), true);
});
