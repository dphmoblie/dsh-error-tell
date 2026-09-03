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

## 0.1.8（设置页「错误哨兵」分区）

- 客户端模块（官方 `__ModuleLoader__` 协议 + `dsh.client` 声明）：`packages/client-tell/client/client.js` 在 dsh 设置页注册 `settings.section`（id `dsh-error-tell`，order 41），内容区自绘（React 外壳 + 原生 DOM）。
- 数据源：新端点 `GET /api/error-tell/plugins`（读取全部 loader 行：group/disabled(含父组)/state(active/failed/idle)/managed/protected/guard/desc），与既有 `/disable` `/restore` `/status` 组合；注入脚本把每页 token 暴露到 `window.__DSH_ERROR_TELL__.token` 供客户端模块调用（CSRF 语义不变：跨源仍读不到）。
- 宿主 bundle 行 name 由 `@dsh-error-tell/client-tell/host` 改为包根（exports `.` → host.mjs）：客户端模块扫描要求 client 条目 id == 包名。
- 测试：客户端模块 VM ×3（loader 注册/导出/apply 注册契约/无 slots 降级）；verify-c 新增断言 `/plugins`（fixture 行 disabled+managed、可操作标记、desc）与 `__DSH_BOOT__` 含 client-tell 客户端模块 → 15/15 全绿。

## 0.1.8+（设置页分类与页签小页面）

- `/api/error-tell/plugins` 每行返回 `kind`：`official`（包名 `@deepseek-ai/` 或 `cordis:`）或 `third`（其余社区包）——**只按包归属分类**；补丁配置/禁用的行不再单列「用户层」（该方案已按用户要求移除），仍按其包归入官方/第三方。
- 设置页「错误哨兵」分区改为**页签式小页面**：全部插件 / 官方插件 / 第三方插件 / 哨兵历史，点击跳转、各自计数；数据一次拉取、切页即时渲染；组行折叠为「组 xxx」标题。
- 单测 `test/kind.test.mjs`（pluginKind 包归属判定）；verify-c 断言 fixture(补丁插入, 社区包)=third、error-tell host=third、存在 official 行。

## dsh 0.1.2-rc.1 适配

- **web 会话认证**：dsh >= 0.1.2-rc.1 首页与 /api 网关置于 browser-trust fence + 会话 cookie 认证；启动打印 `dsh web: http://…/?token=…`，带 token 访问首页 303 → Set-Cookie → 干净路径带 cookie 200。插件经 `webServer.register` 注册的精确路由（/api/error-tell/*）不受网关拦截（e2e 端点断言直接通过）。e2e 统一用「解析 stdout token → 手动 303 换 cookie」流程（rc.6 无 token 时回退裸路径）。
- **官方包解析**：`link-profile.mjs` 支持 `DET_DSH_PREFIX`（隔离安装如 `.tmp/dsh012`）→ 把该安装自带 node_modules/@deepseek-ai junction 进沙箱，模拟真实升级后的解析；e2e 用 `PATH` 前缀指向隔离 dsh 运行。
- **客户端模块双版本**：`dsh.client.inject` 由 `dsh-client-runtime`（0.1.2-rc.1 已无此模块）改为两版均存在的 `@deepseek-ai/dsh-client-ui-settings`；`slots` 服务名两版一致（rc.6 由 dsh-client-runtime、新版由 dsh-client-ui-renderer 提供），`settings.section` 注册契约（register({name,id,order,label}, Component)）不变。
- run-e2e Phase D 断言适配 S2（attempts=2），guard JSON 解析改用 parseLastJson（防贪婪匹配）。
- 验证：verify-c 17/17（rc.6 与 0.1.2-rc.1 双版本）；run-e2e A-H 在 0.1.2-rc.1 全绿（隔离安装）。

## 分类升级：按安装位置判定官方/第三方

- `/api/error-tell/plugins` 的 kind 判定从「只看名字前缀」升级为 `makeKindResolver`：官方 = 名字以 `@deepseek-ai/`/`cordis:` 开头，**或行名解析到的包位于 `@deepseek-ai/dsh` 发行目录自带 node_modules 内**；其余（profile 里用户安装的包、`./xxx.mjs` 相对本地插件等）→ third。
- 单测 3 项覆盖：profile 锚点真实场景（前缀快速通道/第三方/相对文件）、发行目录内可解析的非前缀包按位置判 official、找不到 dsh 时退化前缀规则。

## 发布记录

- 2026-08-28：`@dsh-error-tell/client-tell` 发布 **0.1.7**（pnpm publish 自动把 `workspace:*` 转成 core@0.1.2）。**0.1.6 已废弃**：误用 `npm publish` 导致依赖仍是 `workspace:*`（npm 消费方装不上），且 granular token 无法 unpublish，请勿使用 0.1.6；真实 profile 已升级 0.1.7（含 `minimumReleaseAgeExclude` 补充 0.1.5/0.1.6/0.1.7 等条目）。

## S2（连续失败 + 探针恢复 + 管理面板）

- 场景 A（`pnpm e2e:s2a`）：坏插件第 1 次失败 → 账本 failCount=1、**不写禁用**（观察中）；第 2 次失败 → failCount=2、写入 managed 禁用。8 断言全绿。
- 场景 B（`pnpm e2e:s2b`）：修复插件后 guard 启动探针（临时覆盖 disabled:false 真实加载）→ 成功 → 自动恢复（managed 移除、账本 restoredAt）。3 断言全绿。
- 管理面板：`GET /api/error-tell/status`（活动禁用列表）+ `POST /api/error-tell/restore`；注入脚本在正常页面渲染恢复面板（VM 单测覆盖）。

## 复现

```bash
pnpm test        # 单元测试
pnpm e2e         # 全链路（约 3-4 分钟，自动清理沙箱）
```
