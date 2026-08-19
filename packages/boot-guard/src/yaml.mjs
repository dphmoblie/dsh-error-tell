import { createRequire } from 'node:module';
import { join } from 'node:path';

let cached;

export async function loadYaml() {
  if (cached) return cached;
  const errors = [];
  try {
    const mod = await import('js-yaml');
    cached = mod.default ?? mod;
  } catch (e) { errors.push("import: " + e.message); }
  if (!cached) {
    const candidates = [
      process.env.DSH_INSTALL,
      'D:\\nvm\\nodejs\\node_modules\\@deepseek-ai\\dsh',
      'D:\\nvm\\v26.0.0\\node_modules\\@deepseek-ai\\dsh'
    ].filter(Boolean);
    for (const c of candidates) {
      try { cached = createRequire(join(c, "package.json"))("js-yaml"); break; }
      catch (e) { errors.push(c + ": " + e.message); }
    }
  }
  if (!cached) throw new Error('js-yaml 不可用：' + errors.join(' | ') + '（可 pnpm add js-yaml 或设置 DSH_INSTALL）');
  return cached;
}

/** 解析可能含 !!js 表达式（DSH dump-config / patch）的 YAML 文本。 */
export async function parsePatchYaml(text) {
  const y = await loadYaml();
  const clean = String(text).replace(/^\uFEFF/, '');
  const attempts = [];
  try {
    const jsScalar = new y.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: v => ({ __jsExpr: v }) });
    const jsSeq = new y.Type('tag:yaml.org,2002:js', { kind: 'sequence', construct: v => ({ __jsExpr: v }) });
    const jsMap = new y.Type('tag:yaml.org,2002:js', { kind: 'mapping', construct: v => ({ __jsExpr: v }) });
    const schema = y.DEFAULT_SCHEMA.extend([jsScalar, jsSeq, jsMap]);
    return y.load(clean, { schema });
  } catch (e) { attempts.push("custom schema: " + e.message); }
  try { return y.load(clean.replace(/!!js/g, '!!str')); } catch (e) { attempts.push('str rewrite: ' + e.message); }
  try { return y.load(clean); } catch (e) { attempts.push("default: " + e.message); }
  throw new Error('YAML 解析失败: ' + attempts.join(' | '));
}
