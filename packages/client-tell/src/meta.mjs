// @dsh-error-tell/client-tell：把插件 npm 包名解析为 package.json 元数据（description 等），
// 供管理面板在历史记录里展示「这个插件是干什么的」，方便使用的人排错。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 以 base（目录或目录数组）为锚创建元数据解析器：createRequire 从该目录开始按 node_modules
 * 规则查找，与 loader 的 import(name) 解析一致（profile 目录 → 全局安装都能命中）。
 * 返回 (name) => { name, description } | null，带缓存。
 */
export function makeMetaResolver(bases) {
  const list = (Array.isArray(bases) ? bases : [bases]).filter(Boolean);
  const reqs = [];
  for (const b of list) {
    try {
      const base = isAbsolute(b) ? b : join(process.cwd(), b || ".");
      reqs.push(createRequire(pathToFileURL(join(base, "__dsh_error_tell_anchor__.js"))));
    } catch { /* 非法锚点跳过 */ }
  }
  const cache = new Map();
  function tryResolve(req, name) {
    try {
      const p = req.resolve(name + "/package.json");
      return JSON.parse(readFileSync(p, "utf8"));
    } catch { return null; }
  }
  // exports 限制了 ./package.json 的包（如 @dsh-error-tell/*）：解析主入口后向上找 package.json
  function tryWalk(req, name) {
    try {
      const main = req.resolve(name);
      let dir = dirname(main);
      for (let i = 0; i < 10 && dir !== dirname(dir); i++) {
        try {
          const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          if (j && j.name === name) return j;
        } catch { /* 继续向上 */ }
        dir = dirname(dir);
      }
    } catch { /* 不可解析 */ }
    return null;
  }
  return function resolvePluginMeta(name) {
    if (!name || typeof name !== "string") return null;
    if (cache.has(name)) return cache.get(name);
    let meta = null;
    for (const req of reqs) {
      meta = tryResolve(req, name) || tryWalk(req, name);
      if (meta) break;
    }
    cache.set(name, meta);
    return meta;
  };
}
