export const name = 'fixture-bad-apply';
export function apply() {
  throw new Error('[dsh-error-tell] fixture: apply 阶段抛错（用于测试）');
}
