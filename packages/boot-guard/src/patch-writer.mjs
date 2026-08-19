import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { MANAGED_START, MANAGED_END } from './home.mjs';

/** 读取 managed 段：返回 { text, ids:Set, present }。 */
export function readManaged(patchPath) {
  let text = "";
  try { text = readFileSync(patchPath, "utf8"); } catch { return { text: "", ids: new Set(), present: false }; }
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  if (start >= 0 && end > start) {
    const ids = new Set();
    for (const line of text.slice(start + MANAGED_START.length, end).split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*id:\s*([^\s]+)/);
      if (m) ids.add(m[1].replace(/['"]/g, ""));
    }
    return { text, ids, present: true };
  }
  return { text, ids: new Set(), present: false };
}

export function renderBlock(ids) {
  const lines = [MANAGED_START];
  for (const id of [...ids].sort()) lines.push('- id: ' + id, '  disabled: true');
  lines.push(MANAGED_END, "");
  return lines.join('\n');
}

/** 幂等地把 managed 段改写为给定 id 集合（保留段外内容与注释）。 */
export function writeManaged(patchPath, ids) {
  ids = ids instanceof Set ? ids : new Set(ids);
  const { text, present } = readManaged(patchPath);
  if (!present && text === '' && ids.size === 0) return { ids: [] }; // 无事不创建文件（空 YAML 会破坏 parsePatchList）
  const block = renderBlock(ids);
  let next;
  if (present) {
    const start = text.indexOf(MANAGED_START);
    const end = text.indexOf(MANAGED_END);
    next = text.slice(0, start) + block + text.slice(end + MANAGED_END.length);
  } else {
    next = text.replace(/\s*$/, '') + '\n\n' + block;
  }
  writeFileSync(patchPath + '.tmp', next, 'utf8');
  renameSync(patchPath + '.tmp', patchPath);
  return { ids: [...ids] };
}
