// M3 骨架：浏览器侧按钮逻辑（加载页失败清单 + 禁用并重载）。
// 注意：加载页失败时插件树未启动，此模块不会被加载；
// 按钮需由宿主 tapIndex 注入的独立脚本或 client-web 内核补丁提供。
export const name = 'error-tell-client';
export const apply = (ctx) => {
  // TODO(M3): 渲染"禁用并重载"按钮，调用 /api/errorTell/disable 后 location.reload()
  return () => {};
};
