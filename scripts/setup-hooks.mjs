// 一键接入本仓库的 Git 门禁（P2-20）。
//
// 背景：dsh-error-tell 是**嵌套的独立仓库**，工作区根的 .githooks 与 core.hooksPath
// 只作用于根仓库，本仓库的提交不会触发任何扫描。本脚本把本仓库的 core.hooksPath
// 指向仓库自带的 .githooks。
//
// 注意：hook 是 fail-closed 的（没有 gitleaks 就拒绝提交）。所以本脚本在改写配置前
// 会先检查 gitleaks 是否可用；不可用则**只报告不改配置**，避免把仓库锁死。
//
// 用法：node scripts/setup-hooks.mjs [--force]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 脚本位于 <repo>/scripts/，仓库根是它的上一级
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, '.githooks', 'pre-commit');
const force = process.argv.includes('--force');

function hasGitleaks() {
  // 与 guard 里同样的坑：不能 spawnSync('gitleaks', ...) 之前先假定存在；用 shell 探一下
  const r = spawnSync('gitleaks version', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 15000 });
  return r.status === 0 ? (r.stdout || r.stderr || '').trim().split('\n')[0] : null;
}

if (!existsSync(HOOK)) {
  console.error('找不到 ' + HOOK);
  process.exit(1);
}

const version = hasGitleaks();
if (!version && !force) {
  console.error('未检测到 gitleaks，**未修改任何 git 配置**（hook 是 fail-closed 的，');
  console.error('接上会让此后所有提交被拒绝）。请先安装 gitleaks，或确认后重跑：');
  console.error('  node scripts/setup-hooks.mjs --force');
  process.exit(2);
}

const set = spawnSync('git config core.hooksPath .githooks', { cwd: ROOT, encoding: 'utf8', shell: true, windowsHide: true });
if (set.status !== 0) {
  console.error('设置 core.hooksPath 失败：' + (set.stderr || set.stdout || '').trim());
  process.exit(1);
}

const cur = spawnSync('git config --get core.hooksPath', { cwd: ROOT, encoding: 'utf8', shell: true, windowsHide: true });
console.log('core.hooksPath = ' + (cur.stdout || '').trim());
console.log(version ? 'gitleaks: ' + version : 'gitleaks: 未安装（--force 已强制接入，提交会被 hook 拒绝直到装上）');
