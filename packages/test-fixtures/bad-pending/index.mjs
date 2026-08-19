export const name = 'fixture-bad-pending';
export const inject = ['no-such-service-xyz'];
export function apply() { /* 永远不会激活：等待不存在的服务 */ }
