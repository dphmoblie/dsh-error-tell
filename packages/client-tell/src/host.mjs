export const name = 'error-tell-client-host';
export const inject = [];

export function apply(ctx) {
  ctx.logger?.info?.('[dsh-error-tell] client-tell host 骨架已挂载（M3: errorTell/disable Remote 待实现）');
  return () => {};
}
