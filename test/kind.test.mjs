import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginKind, userLayerIds } from '../packages/client-tell/src/host.mjs';

test('pluginKind：官方 / 第三方 / 用户层分类与优先级', () => {
  const empty = new Set();
  assert.equal(pluginKind('a', '@deepseek-ai/dsh-base', empty), 'official');
  assert.equal(pluginKind('a', 'cordis:include', empty), 'official');
  assert.equal(pluginKind('a', 'dshmarket', empty), 'third');
  assert.equal(pluginKind('a', '@linxin666/dsh-web-ui-all', empty), 'third');
  assert.equal(pluginKind('a', null, empty), 'third');
  assert.equal(pluginKind('a', '', empty), 'third');
  // 用户层优先：官方/第三方包行只要出现在用户补丁里就算 user
  const user = new Set(['a', 'b']);
  assert.equal(pluginKind('a', '@deepseek-ai/dsh-goal', user), 'user');
  assert.equal(pluginKind('b', '@openbiliclaw/dsh-plugin', user), 'user');
  assert.equal(pluginKind('c', 'dshmarket', user), 'third');
});

test('userLayerIds：读取补丁行 id，排除 managed 自动段，缺文件容忍', () => {
  const dir = mkdtempSync(join(tmpdir(), 'det-kind-'));
  try {
    const profile = join(dir, 'profiles', 'web');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: openbiliclaw',
      "      name: '@openbiliclaw/dsh-plugin'",
      '- id: better-sidebar',
      '  disabled: true',
      ''
    ].join('\n'));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '# --- dsh-error-tell managed (auto-generated; do not edit) ---',
      '- id: llm-pi-ai',
      '  disabled: true',
      '# --- end dsh-error-tell managed ---',
      '- id: telemetry',
      '  disabled: true',
      ''
    ].join('\n'));
    const ids = userLayerIds([join(profile, 'cordis.patch.yml'), join(home, 'cordis.patch.yml'), join(dir, 'missing.yml')]);
    assert.deepEqual([...ids].sort(), ['better-sidebar', 'openbiliclaw', 'telemetry']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
