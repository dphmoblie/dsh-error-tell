import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMetaResolver } from '../packages/client-tell/src/meta.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-error-tell-meta-'));
  const plain = join(dir, 'node_modules', 'plain-plugin');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'plain-plugin', description: 'plain desc' }));
  const scoped = join(dir, 'node_modules', '@scope', 'thing');
  mkdirSync(scoped, { recursive: true });
  writeFileSync(join(scoped, 'package.json'), JSON.stringify({ name: '@scope/thing', description: 'scoped desc' }));
  const restricted = join(dir, 'node_modules', 'restricted-plugin');
  mkdirSync(restricted, { recursive: true });
  writeFileSync(join(restricted, 'package.json'), JSON.stringify({ name: 'restricted-plugin', description: 'restricted desc', exports: { '.': './main.js' } }));
  writeFileSync(join(restricted, 'main.js'), 'export default {};');
  return dir;
}
test('meta resolver: plain and scoped', () => {
  const dir = fixture();
  try {
    const resolve = makeMetaResolver(dir);
    assert.equal(resolve('plain-plugin').description, 'plain desc');
    assert.equal(resolve('@scope/thing').description, 'scoped desc');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('meta resolver: exports-restricted falls back to main entry', () => {
  const dir = fixture();
  try {
    const resolve = makeMetaResolver(dir);
    assert.equal(resolve('restricted-plugin').description, 'restricted desc');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('meta resolver: unknown/empty returns null, cached', () => {
  const dir = fixture();
  try {
    const resolve = makeMetaResolver(dir);
    assert.equal(resolve('no-such-plugin'), null);
    assert.equal(resolve(''), null);
    assert.equal(resolve(null), null);
    const a = resolve('plain-plugin');
    const b = resolve('plain-plugin');
    assert.equal(a, b, 'cache hit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('meta resolver: relative anchor falls back to cwd', () => {
  const resolve = makeMetaResolver('.');
  assert.equal(typeof resolve, 'function');
  assert.equal(resolve('definitely-not-a-real-pkg-xyz'), null);
});
