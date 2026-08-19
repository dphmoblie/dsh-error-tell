#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { guard } from '../src/guard.mjs';
import { loadLedger, restoreQuarantine, activeQuarantine } from '../src/quarantine.mjs';
import { readManaged } from '../src/patch-writer.mjs';
import { dshHome, homePatchPath, quarantinePath } from '../src/home.mjs';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile: { type: 'string', default: 'web' },
    patch: { type: 'string', multiple: true, default: [] },
    'dry-run': { type: 'boolean', default: false },
    'restart-limit': { type: 'string', default: '2' },
    'max-disable': { type: 'string', default: '50' },
    'fail-threshold': { type: 'string', default: '2' },
    'no-import-checks': { type: 'boolean', default: false },
    dsh: { type: 'string', default: 'dsh' },
    'timeout-ms': { type: 'string', default: '120000' },
    port: { type: 'string' },
    help: { type: 'boolean', default: false }
  },
  allowPositionals: true
});

const usage = [
  '用法:',
  '  dsh-error-tell guard [--profile web] [--patch <file>] [--dry-run] [--restart-limit N] [--port 0]',
  '  dsh-error-tell restore <rowId>',
  '  dsh-error-tell status',
  '  dsh-error-tell quarantine',
].join('\n');
if (values.help) { console.log(usage); process.exit(0); }

const cmd = positionals[0] ?? 'guard';
const home = dshHome();

if (cmd === 'guard') {
  let r;
  try {
  r = await guard({
    profile: values.profile,
    patchFiles: values.patch,
    dryRun: values["dry-run"],
    restartLimit: Number(values["restart-limit"] || 2),
    maxDisable: Number(values["max-disable"] || 50),
    threshold: Number(values["fail-threshold"] || 2),
    importChecks: !values["no-import-checks"],
    dshBin: values.dsh,
    timeoutMs: Number(values["timeout-ms"] || 120000),
    port: values.port !== undefined ? Number(values.port) : 0,
    quitAfterMs: Number(process.env.DSH_ERROR_TELL_QUIT_AFTER_MS || 0),
    env: process.env
  });
  } catch (e) {
    console.error('[dsh-error-tell] guard 失败（未修改任何配置）: ' + (e?.message ?? e));
    process.exit(6);
  }
  const ok = r.dryRun ? true : (r.spawn?.quit || (r.spawn?.code !== null && [0, 130, 143].includes(r.spawn.code)));
  console.log(JSON.stringify({
    ok, dryRun: !!r.dryRun, attempts: r.attempts, disabled: r.disabled,
    spawn: r.spawn ? { code: r.spawn.code, quit: r.spawn.quit, timedOut: r.spawn.timedOut } : null,
    errorCount: r.issues.filter(i => i.severity === 'error').length
  }, null, 2));
  process.exit(ok ? 0 : 5);
} else if (cmd === 'restore') {
  const rowId = positionals[1];
  if (!rowId) { console.error("用法: dsh-error-tell restore <rowId>"); process.exit(2); }
  const hit = restoreQuarantine(home, rowId);
  const managed = readManaged(homePatchPath(home));
  if (managed.ids.has(rowId)) {
    managed.ids.delete(rowId);
    const { writeManaged } = await import('../src/patch-writer.mjs');
    writeManaged(homePatchPath(home), managed.ids);
  }
  console.log(hit ? "已恢复 " + rowId : "账本中无 " + rowId + " 的活动记录");
  process.exit(hit ? 0 : 3);
} else if (cmd === 'status') {
  const ledger = loadLedger(home);
  const managed = readManaged(homePatchPath(home));
  console.log("DSH_HOME:", home);
  console.log("patch:", homePatchPath(home));
  console.log("managed 禁用:", [...managed.ids].sort().join(", ") || "(无)");
  console.log("quarantine:", quarantinePath(home));
  for (const e of ledger.entries) {
    console.log(' - ' + e.rowId + ' [stage=' + e.stage + ' source=' + e.source + '] ' + (e.restoredAt ? '已恢复 ' + e.restoredAt : '活动中 ' + e.at) + (e.error ? ' :: ' + String(e.error).split('\n')[0] : ''));
  }
} else if (cmd === 'quarantine') {
  console.log(JSON.stringify(activeQuarantine(home), null, 2));
} else {
  console.error("未知命令: " + cmd + "\n" + usage);
  process.exit(2);
}
