#!/usr/bin/env node
/*
 * 白名单覆盖审计：拿一份真实 profile 的行清单，检查哪些行不在自动禁用保护名单内。
 *
 * 用法：
 *   node scripts/audit-whitelist.mjs <loader-dump.yml> [core/src/index.mjs]
 *   node scripts/audit-whitelist.mjs            # 默认取 $DSH_HOME/profiles/web/dump-before-disable.json
 *
 * dump 由 dsh loader dump 产出（形如 "# == @deepseek-ai/dsh-base\n- id: <rowid>\n  name: <pkg>"）。
 * 期望：官方包（@deepseek-ai/）未受保护行数为 0；第三方行仍应可被自动禁用（这是守卫的用途）。
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const dumpPath = process.argv[2] || join(home, 'profiles', 'web', 'dump-before-disable.json');
const corePath = process.argv[3] || new URL('../packages/core/src/index.mjs', import.meta.url).href;

const { isProtected, PROTECTED_IDS, PROTECTED_SCOPES } = await import(corePath);

const rows = [];
let cur = null;
for (const line of fs.readFileSync(dumpPath, 'utf8').split(/\r?\n/)) {
  const mId = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line);
  if (mId) { cur = { id: mId[1].replace(/^['"]|['"]$/g, ''), name: undefined }; rows.push(cur); continue; }
  const mName = /^\s+name:\s*(.+?)\s*$/.exec(line);
  if (mName && cur && cur.name === undefined) cur.name = mName[1].replace(/^['"]|['"]$/g, '');
}

const uniq = new Map();
for (const r of rows) if (!uniq.has(r.id)) uniq.set(r.id, r);

const isOfficial = r => !!(r.name && PROTECTED_SCOPES.some(s => String(r.name).startsWith(s)));
const unprotected = [...uniq.values()].filter(r => !isProtected(r.id, r.name));
const officialUnprotected = unprotected.filter(isOfficial);

console.log('dump:', dumpPath);
console.log('总行数(去重 id):', uniq.size);
console.log('PROTECTED_IDS 条目:', PROTECTED_IDS.size);
console.log('未受保护行数:', unprotected.length, '（其中官方包', officialUnprotected.length, '）');
if (officialUnprotected.length) {
  console.log('\n!! 官方包裸奔行（应为 0）:');
  for (const r of officialUnprotected) console.log('  ', r.id, r.name);
}
console.log('\n未受保护的第三方行（可自动禁用，正常）:');
for (const r of unprotected.filter(r => !isOfficial(r))) console.log('  ', r.id, r.name);

process.exitCode = officialUnprotected.length ? 1 : 0;
