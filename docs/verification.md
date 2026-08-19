# 验证记录（e2e）

沙箱 `DSH_HOME` 全链路（不触碰真实 `~/.dsh`），命令：`node test/e2e/run-e2e.mjs`

## 覆盖场景

**Phase A — boot-guard 包装（主防线）**

1. pnpm install fixture（offline）成功，fixture 链接到 profile node_modules
2. `dsh --dump-config` 组合配置包含坏插件行
3. 坏插件（apply 抛错）→ `dsh web` 启动失败 exit 1，stderr 归因到插件名
4. `dsh-error-tell guard`：预检 → spawn 失败 → stderr 归因 → 写 `disabled: true` 到 home patch managed 段 + quarantine 账本 → 自动重启
5. 重启后 web 正常启动（attempts=2，quit 钩子验证服务存活）
6. 再次 dump-config：该行已 `disabled: true`
7. `restore <rowId>`：清除禁用、账本标记恢复

**Phase B — runtime-guard 插件（辅防线）**

8. runtime-guard bundle 装入 profile，坏插件启动失败时，runtime-guard 在进程 fail-loud 退出**之前**同步写入账本与 managed 禁用段

## 结果

- 首次验证：13 ✔ / 0 ✖（Phase A）
- 含 Phase B：17 ✔ / 0 ✖
- 含 Phase C–H：全部 ✔ / 0 ✖
  - C: client-tell 注入 + 禁用端点 + 组合图排除（刷新恢复）
  - D: 宿主 import 失败被预检拦截（无需重启）
  - E: 幂等性——干净 profile 零副作用（无 home patch/账本产生）
  - F: YAML 损坏 → guard 友好失败（exit 6，不改配置）
  - G: 多坏插件（import + apply）一次清理（25s quit 窗口）
  - H: apply 挂起 → 进程级 timeout → 熔断不循环（exit 5，零配置修改）
  - 注：pending（缺注入服务）在宿主侧不阻断启动（Cordis 静默不激活），已用幂等性验收替代
- 单元测试：14 ✔ / 0 ✖（含 runtime-guard recordFailure/countManaged、注入脚本恢复面板）
- 真实 profile 冒烟：153 行组合解析成功，静态检查 0 问题（只读，不写配置）

## S2（连续失败 + 探针恢复 + 管理面板）

- 场景 A（`pnpm e2e:s2a`）：坏插件第 1 次失败 → 账本 failCount=1、**不写禁用**（观察中）；第 2 次失败 → failCount=2、写入 managed 禁用。8 断言全绿。
- 场景 B（`pnpm e2e:s2b`）：修复插件后 guard 启动探针（临时覆盖 disabled:false 真实加载）→ 成功 → 自动恢复（managed 移除、账本 restoredAt）。3 断言全绿。
- 管理面板：`GET /api/error-tell/status`（活动禁用列表）+ `POST /api/error-tell/restore`；注入脚本在正常页面渲染恢复面板（VM 单测覆盖）。

## 复现

```bash
pnpm test        # 单元测试
pnpm e2e         # 全链路（约 3-4 分钟，自动清理沙箱）
```
