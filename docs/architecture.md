# dsh-error-tell 架构

## 分层

1. **boot-guard（启动预检 + 重启包装）**
   - 组合配置：spawn `dsh --profile <p> --dump-config`，解析 composed 行清单
     （`!!js` 表达式以 `{__jsExpr}` 形式保留，不执行）。
   - 静态检查：行 id 重复 / 启用的行缺 name / client-only 包跳过。
   - import 干跑：子进程 `node --input-type=module -e "import(name)"`，
     cwd 依次尝试 profile 目录与 dsh 安装目录；失败归类为 import 错误。
   - 落盘：隔离账本 quarantine.json + home 补丁 managed 段（`disabled: true`）。
   - 启动：spawn `dsh --profile <p> --port <port>`；退出码非 0 且 stderr 中出现
     已知行名 → 追加禁用 → 重启（上限 restart-limit，无法归因时熔断不循环）。

2. **runtime-guard（宿主看门狗）**
   - 作为补丁层最后一行插入（`id: error-tell-runtime`）。
   - 监听 `internal/status`（fiber → FAILED=3）与 `loader/entry-init` 的
     `_initTask` 拒绝；**同步**写账本 + managed 段（避免进程在异步写完成前退出）。
   - 不注入任何被守卫服务、不禁自己、失败只记日志。

3. **client-tell（浏览器侧，M3）**
   - 加载页失败清单 + "禁用并重载"按钮；host Remote `errorTell/disable`
     写禁用后 `location.reload()`。客户端 loader `write()` 是 no-op，
     持久化必须走宿主配置。

## 关键机制

- `dsh-client-modules` 组装 `window.__DSH_BOOT__` 时跳过
  `disabled` / 无 fiber 的 client 行 → 宿主侧禁用即"下次打开正常"。
- patch 语义：`{id, disabled: true}` 只覆盖单行；同 id 后写者胜出，
  用户后续自行 patch 可覆盖本工具。
- 退出码协议：`guard` 认为 `0 / 130 / 143 / quit` 为正常结束，其余为失败。
