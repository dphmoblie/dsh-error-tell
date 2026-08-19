export const name = 'fixture-bad-hang';
export function apply() {
  // 永不返回：模拟 apply 挂起（loader 永远等不到 settle）
  return new Promise(() => {});
}
