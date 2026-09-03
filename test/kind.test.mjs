import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginKind } from '../packages/client-tell/src/host.mjs';

test('pluginKind：仅按包归属分官方/第三方', () => {
  assert.equal(pluginKind('@deepseek-ai/dsh-base'), 'official');
  assert.equal(pluginKind('@deepseek-ai/dsh-goal'), 'official');
  assert.equal(pluginKind('cordis:include'), 'official');
  assert.equal(pluginKind('dshmarket'), 'third');
  assert.equal(pluginKind('@linxin666/dsh-web-ui-all'), 'third');
  assert.equal(pluginKind('@dsh-error-tell/client-tell'), 'third');
  assert.equal(pluginKind('@openbiliclaw/dsh-plugin'), 'third');
  assert.equal(pluginKind(null), 'third');
  assert.equal(pluginKind(''), 'third');
  assert.equal(pluginKind(undefined), 'third');
});
