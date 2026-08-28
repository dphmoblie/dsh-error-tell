// e2e 沙箱依赖安装：用 junction/符号链接把仓库内的包链接进 profile node_modules，
// 等价于 pnpm 安装 file: 依赖的产物。
// 为什么不用 pnpm install --offline：pnpm 11 起，file: 链接包内的 workspace:* 协议
// 只能在「安装目录位于同一 workspace」时解析；os.tmpdir 沙箱会直接报
// ERR_PNPM_WORKSPACE_PKG_NOT_FOUND（client-tell 依赖 core: workspace:*）。
// 链接后 Node ESM import 默认 realpath 到仓库内包，包自身的依赖
// （client-tell → core → js-yaml）由仓库根的 pnpm install 提供的 node_modules 解析。
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * 在 profile 目录下建 node_modules 链接。
 * @param profileDir profile 目录（其下会创建 node_modules/@scope/name → 仓库内目录）
 * @param links { spec: 相对仓库根路径 }，如 { '@dsh-error-tell/client-tell': 'packages/client-tell' }
 */
export function linkProfile(profileDir, links) {
  for (const [spec, rel] of Object.entries(links)) {
    const target = join(E2E_ROOT, rel);
    const linkPath = join(profileDir, 'node_modules', ...spec.split('/'));
    mkdirSync(join(linkPath, '..'), { recursive: true });
    try {
      symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
