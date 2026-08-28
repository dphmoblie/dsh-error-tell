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
- 单元测试：32 ✔ / 0 ✖（core + boot-guard + runtime-guard + 注入脚本 VM + meta 解析）

## 0.1.6（面板跟随徽标 + 历史记录功能描述）

- 注入脚本：面板不再固定右下角，而是锚定在徽标旁（上方、右缘对齐，视口内自动收边）；**拖动徽标时面板实时跟随**（VM 单测覆盖初始锚定 + 拖动跟随）。
- 历史记录：`/api/error-tell/status` 为每条记录附带 `name`（npm 包名）与 `desc`（package.json description），面板在每行下方显示**功能描述 + 包名 + 失败原因**；「仅记录」改为可展开折叠区（`<details>`），同样展示原因；鼠标悬停行可看完整描述（title）。
- 元数据解析（`packages/client-tell/src/meta.mjs`）：以 loader baseUrl（profile 目录）为锚用 `createRequire` 解析（与 loader import 同源），兜底 `process.cwd()` 与 `~/.dsh/profiles/*`；`exports` 限制 `./package.json` 的包回退主入口向上查找（单测覆盖）。
- e2e Phase C 新增断言：`/status` 返回 `disabled:true` 且 `desc` 含 fixture 描述。

## 0.1.6 附：e2e 基础设施与探针修复

- **沙箱安装改 junction 链接**（`test/e2e/link-profile.mjs`）：pnpm 11 起 `file:` 链接包内的 `workspace:*` 协议无法在 `os.tmpdir` 沙箱解析（`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`），全部 e2e 脚本改为把仓库包 junction 进 profile node_modules（等价 pnpm 产物；Node ESM realpath 后包内依赖由仓库根安装解析）。verify-c 全绿。
- **探针 bug 修复**（`packages/boot-guard/src/guard.mjs`）：探针每轮临时启用已禁用行，若插件仍坏：① 启动会失败；② 失败后若重启成功，会把**仍坏的行误恢复**（禁用/恢复死循环）。修复：归因失败的探针行记录 `probeFailed`，从探针覆盖剔除；重启次数用尽时**追加一次无探针的干净启动**（保证禁用生效、web 能开）；成功路径只恢复未失败的行。verify-d D3 增加断言：禁用后启动成功且该行保持禁用/账本仍活动中。
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
