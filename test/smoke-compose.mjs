// 冒烟验证：真实 profile 组合 + 静态检查（不写任何配置）
import { composeRows } from '../packages/boot-guard/src/compose.mjs';
import { runChecks } from '../packages/boot-guard/src/checks.mjs';
const profile = process.argv[2] ?? 'web';
const { rows } = await composeRows(profile, []);
console.log('rows:', rows.length);
console.log('sample:', JSON.stringify(rows.slice(0, 2), null, 1).slice(0, 600));
const issues = await runChecks(rows, { importChecks: false });
console.log('static issues:', issues.length);
for (const i of issues.slice(0, 20)) console.log(' ', i.severity, i.stage, i.rowId, '::', String(i.message).split('\n')[0]);
