# dsh-error-tell — 详细开发计划

仓库：https://github.com/dphmoblie/dsh-error-tell
目标：一个 DSH 插件（bundle），在 `dsh web` 启动时检测其他插件的加载/激活问题，
持久化禁用问题插件（写入用户补丁层 `disabled: true`），使 dsh web 正常打开，
并提供清晰的错误报告与恢复手段。

## 0. 背景与可行性结论（已基于本机 DSH rc.6 源码核实）

- 宿主侧：任一插件 import/apply 失败 → `boot()` 抛错 → `installFailLoud` exit(1)；
  `loader.await()` 会对失败 fiber 重新抛错，`assertEntriesActivated` 兜底 pending/无 fiber。
  ⇒ 同树看门狗**救不了当次启动**，只能检测 + 落盘，靠重启恢复。
- 浏览器侧：`dsh-client-web` 一次性 settle，`Promise.all(create)` fail-fast；
  加载页显示 "Failed to load plugins" 与条目清单；浏览器内 loader `write()` 为 no-op，禁用不持久。
- 持久化通道（关键）：`dsh-client-modules` 组装 `window.__DSH_BOOT__` 时跳过
  `disabled` / 无 fiber 的 client 行 ⇒ 宿主侧写 `disabled: true` 后，下次打开页面即恢复正常。
- 禁用写入位置（按优先级）：`$DSH_HOME/cordis.patch.yml`（home 级，默认）
  或 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（profile 级）；`watchUserPatches` 支持热重载。
- 官方 plugin-inventory 只读、无禁用 API；`dsh plugin remove` 是整包移除。
- 结论：采用「启动预检 + 运行时看门狗 + 浏览器禁用按钮」三层设计；"检测+落盘禁用"可行，
  "当次启动救活"不可行，必须配合重启/刷新。

## 1. 总体设计（三层）

### 1.1 boot-guard（启动预检 + 重启包装）—— 主防线
流程：组合配置（`dsh --dump-config`）→ 静态校验 → import 干跑（子进程）→
隔离账本 + 写禁用 patch（managed 段）→ 启动 `dsh web` → 失败归因 → 追加禁用 → 重启（限次熔断）。

### 1.2 runtime-guard（宿主运行时看门狗插件）—— 辅防线
补丁层最后插入 `id: error-tell-runtime`；不 inject 被守卫服务；监听 `internal/status` 与
`_initTask`；同步写账本 + 禁用 patch；退出码协议触发重启；自身安全：排除自身、不递归。

### 1.3 client-tell（浏览器「禁用并重载」按钮）—— 用户闭环
加载页失败清单 + 按钮 → host Remote `errorTell/disable` → `location.reload()`。

## 2. 仓库结构（pnpm workspace monorepo）

```
dsh-error-tell/
  package.json / pnpm-workspace.yaml
  packages/
    boot-guard/        # 预检 CLI + 重启包装（bin: dsh-error-tell）
    runtime-guard/     # 宿主看门狗 bundle（dsh.bundle.patch）
    client-tell/       # 双面包：host Remote + client UI 按钮（M3）
    test-fixtures/     # 坏插件工厂
  test/e2e/            # 沙箱 DSH_HOME 全链路验收
  docs/
```

## 3. 里程碑

- M0 环境与 PoC：骨架、坏插件、复现打不开、禁用通道验证 ✅
- M1 boot-guard：组合/静态检查/import 干跑/账本/patch-writer/重启包装 ✅（骨架）
- M2 runtime-guard：事件捕获/同步落盘/重启协议 ✅（骨架）
- M3 client-tell：失败清单暴露 + 按钮 + Remote ⏳
- M4 测试/文档/发布：e2e 用例矩阵、幂等性、README、npm ⏳

## 4. 验收标准

1. 预置坏插件时，经 guard 启动的 `dsh web` 最终正常打开，坏行在 home patch 中 `disabled: true`；
2. quarantine 账本可审计；`dsh-error-tell restore <rowId>` 能清除禁用并恢复；
3. 无坏插件时启动完全幂等（不改任何配置）；
4. 熔断：重启循环上限、单次禁用上限、看门狗不递归不禁自己；
5. 三种故障形态（宿主 import / 宿主 apply / 客户端 import）各有 e2e 用例且通过；
6. README/架构文档完整，含安全与信任说明。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 客户端 import 失败无救活窗口 | boot-guard 干跑 client bundle import，提前拦截 |
| 插件 apply 挂起 | 包装层进程级 timeout + 强杀 + 禁用 |
| 配置/patch YAML 损坏 | guard 解析兜底，提示 dump-default-config |
| 看门狗误杀 | 信任标记、账本、restore、限次熔断 |
| 与 watchUserPatches / HMR 联动 | e2e 覆盖热重载场景 |
| DSH rc.6 API 演进 | 锁定版本快照 + 回归 e2e |
| 递归禁用 | 排除自身 id + 白名单校验 |
