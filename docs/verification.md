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
- 含 Phase C–G：约 40 ✔ / 0 ✖
  - C: client-tell 注入 + 禁用端点 + 组合图排除（刷新恢复）
  - D: 宿主 import 失败被预检拦截（无需重启）
  - E: pending（缺服务）被归因禁用并重启
  - F: YAML 损坏 → guard 友好失败（exit 6，不改配置）
  - G: 多坏插件（import + apply）一次清理
- 单元测试：6 ✔ / 0 ✖（yaml !!js 容错、quarantine、patch-writer、inferFailures、注入脚本 VM 测试 ×2）
- 真实 profile 冒烟：153 行组合解析成功，静态检查 0 问题（只读，不写配置）

## 复现

```bash
pnpm test        # 单元测试
pnpm e2e         # 全链路（约 3-4 分钟，自动清理沙箱）
```
