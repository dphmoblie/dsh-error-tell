# 技术评审报告（子代理独立评估）

> 评审时间：2026-08（HEAD fd7ad06 前后）；评审对象：三层设计 + e2e + CI。
> 评审方法：对照本机 DSH @deepseek-ai/dsh@0.1.0-rc.6 源码逐一核实机制，并做了 3 项实测（单测 7/7、restore 空块复现、干净 profile 预检 0 误报）。

## 总体结论

方向正确、机制落地扎实（评审者对 DSH rc.6 机制判断均经源码核实），但存在 **1 个会砸掉启动的恢复流程缺陷**（S1，已修复）+ 若干误杀/安全/发布问题。

## 已修复

- **S1（严重）**：restore 清空 managed 段后生成注释-only patch 导致 `dsh web` 无法启动 → 已修复：ids 为空且文件仅含 managed 段时删除文件，否则仅移除该段；补单测。
- **S4（严重）**：stderr 归因子串匹配误杀面大 → 已修复：行首 `name:` 精确格式 + 包名边界 + 显式 id 引用三种精确匹配；补单测（含"不应命中"用例）。

## 本轮修复（2026-09 哨兵 bug 排查）

单测 39 → 51 项全绿（新增 checks 5 项 + quote 6 项 + 自锁回归 1 项）。
验证方式：前置复现脚本实测（见下方"实证"），修复后复测通过。

### 严重

- **B1（已实证）`inferFailures` 显式 id 引用为裸子串匹配 → 会禁用「错误的」插件**。
  原实现 `s.includes('id: ' + row.id)`：id 互为前缀时互相命中，
  例如 stderr 为 `id: ab` 时 `id: a` 的行也被归因。实测：
  `inferFailures('boom id: ab', [{id:'a'},{id:'ab'}])` 返回 `['a','ab']`（应为 `['ab']`）；
  `entry ab` 同理。→ 已修复：改为带词边界的正则 `id:\s*<id>(?![\w.-])` 与 `entry\s+<id>(?![\w.-])`；
  补回归用例（含 `id: a-extra` 不应命中的反例）。
- **B2（=S3，已实证）`recordFailure` 熔断按 managed 历史总量计数 → 永久自锁**。
  实测：用户已有 5 个合法禁用行（= maxDisable 默认值）时，新坏插件返回 false，永远不会被自动禁用，
  守护静默失效。`boot-guard` 的 `assertDisableLimit` 本来就是按「本次增量」判定，两者语义不一致。
  → 已修复：`core` 记录「本次进程新增禁用了哪些行」，按增量熔断；新增 `resetRunDisabled()`；
  删除了把旧行为固化的单测，替换为自锁回归 + 增量达上限两条。

### 中等

- **B3（新发现）`client-tell` 的 `readBody` 超长请求体会让端点永久挂死**。
  原实现超限时只 `req.destroy()`，而 destroy 不保证触发 `end`/`error`，
  promise 可能永不 resolve → 该请求挂死、连接与内存泄漏。→ 已修复：`close` 兜底，
  返回 `{ raw, tooLarge }`，超限端点回 `413`。
- **B4（新发现）`disable` 端点先写账本再判上限**：会在账本留下「记录了但没真正禁用」的假条目，
  且同样按 managed 历史总量判上限（用户已有 maxDisable 个禁用行后，面板上再也禁不掉新插件）。
  → 已修复：先判上限、写 managed 成功后才记账；上限改为「本次会话手动新增」增量计数。
- **B5（新发现，M1 的一部分，已实证）`quoteArg` 用 POSIX 转义处理 Windows 参数**。
  原实现把每个 `\` 都变成 `\\`，于是 `runDsh` 传给 dsh 的**所有 Windows 路径都是双反斜杠**：
  本地盘符被 Windows 容错掉（所以 e2e 未暴露），**UNC 路径直接失效**。
  实测 6 个用例原本 4 个往返失败（`C:\Temp\x.yml` → `C:\\Temp\\x.yml`）。→ 已修复：
  按 cmd.exe/MSVCRT 规则实现（内嵌 `"` → `\"`；仅紧邻引号或结尾的连续 `\` 加倍）；
  实测 6/6 往返正确；`quoteArgWin` 独立导出并补 6 条跨平台单测。
  已知残留：`%` 在 cmd 引号内仍会展开变量，本函数不处理（路径含 `%` 极罕见），已在注释说明。

### 优化（M8 的一半）

- **`checks.runChecks` 的 import 干跑由逐行串行改为有界并发**（默认 `concurrency: 4`）。
  原先 N 个包的最坏耗时是 `Σtimeout`（坏包还要各等满 20s），现在降到约 `⌈N/concurrency⌉ × timeout`。
  实现要点：两阶段（先静态检查登记 plan，再并行干跑，最后按原行顺序回放 issues），
  **保持 issues 顺序与串行实现完全一致**；`runner` 可注入，因此新增 5 条单测无需 spawn。
  过程中自查发现并修掉了自己引入的缺陷：若在第一阶段就用 `Promise.resolve().then()` 启动 runner，
  限流会完全失效（实测并发冲到 12），改为惰性启动函数后才真正受控（并发 ≤ 3）。
  另新增 `clearImportCache()` 并在 `guard()` 入口调用，避免长驻进程复用发霉的干跑结果。

### 严重（续）：runtime-guard 实测发现

- **B6（实测确认——原 M7 预判的"静默失效"确实发生了）runtime-guard 完全漏检 profile 插件的
  import 失败，并把级联错误误归因给受保护行 `include`。**
  用本机 dsh `0.1.5-alpha.1` + `fixture-bad-import` 实测（装载方式与 e2e Phase B 相同）：

  | 观察项 | 实测结果 |
  |---|---|
  | 账本条目 | `[{rowId:"include", stage:"import", source:"runtime-guard-protected"}]` —— 真凶 `fixture-bad-import` 从未出现 |
  | runtime-guard apply 时的 `ctx.loader.entries()` | 154 条，**其中没有任何 fixture 条目** |
  | 整个启动收到的 `loader/entry-init` | 仅 2 次，且都是匿名条目 |
  | 包裹 `Entry.prototype._init` 后捕获到的调用 | 仅 2 次（匿名）；fixture 的 `_init` 在 apply 之前就已启动 |

  根因（四条叠加，已逐条定位到源码行）：

  1. profile 插件条目由 **`include` 子树**的 loader 创建（`dsh-app-boot`），不在 runtime-guard
     自己的 `ctx.loader.entries()` 快照里；
  2. `entry-init` **在 Entry 构造函数末尾同步触发**，而 `options` 要到
     `update()`（`cordis-plugin-loader/lib/index.js:424`）才赋值，此刻恒为空对象 `{}`，
     于是 `entry.options.id` 拿不到，原实现 `if (!rowId) return` 直接跳过；
  3. `_initTask` 只在 `init()` 内赋值、并在 `_init()` 完成的 `finally`（第 507 行）里被清回 `undefined`，
     事后挂钩子必然赶不上；
  4. **import 失败不产生 fiber**，所以 `internal/status` 也没有信号——这正好解释了为什么
     Phase B 的 apply 用例一直是好的，而 import 用例全漏。

  → **已修**：父条目的拒绝里带着完整 cause 链
  （`failed to apply loader entry include (cordis:include): failed to import loader entry fixture-bad-import (...)`），
  于是新增 `culpritOf(err)` **沿 `.cause` 链归因到最深层肇事条目**，父条目不再背锅。
  同一实验修复后：账本变为 `[{rowId:"fixture-bad-import", stage:"import", source:"runtime-guard"}]`，可复现。
  另补 4 条 `culpritOf`/`stageOf` 单测（含 cause 链自环不无限循环）。

### 中等（续）

- **M7**：~~对 DSH 私有 API（`_initTask`/`_error`/`fiber.state`）无版本护栏~~ → **已修**：
  新增 `capabilityReport(ctx)`，在 apply 时自检 `loader.entries()` / `entry._initTask` / `fiber.state`
  的形状，不匹配时用 `detectDshVersion()` 带上 dsh 版本**显式告警**，而不是静默失效。
  本机 dsh 为 `0.1.5-alpha.1`、CI 钉 `0.1.0-rc.6`，自检只判形状不比对具体版本号，故两边都兼容。

- **M5（跨平台）**：~~e2e 固定端口~~ → **已修**：四个脚本（`run-e2e`/`verify-c`/`verify-cd`/`verify-s3c`）
  原先都用「开探针 server 拿端口 → 关闭 → 让 dsh 绑同一端口」，存在 TOCTOU 竞态
  （关闭到绑定之间端口被抢 → `EADDRINUSE`，而它属环境类错误会被归因逻辑过滤，guard 只会熔断退出）。
  改为 `--port 0` + 从 dsh stdout 的 `dsh web: <url>?token=` 取真实端口
  （`dsh-web-app/lib/index.js:95` 的 `localWebUrl` 用的是 `ctx.get("webServer").port`，即实际绑定端口），
  竞态从根上消失，Phase C 不再需要任何预先探针。
  `taskkill` 的 5 处重复实现收敛到 `compose.mjs` 的跨平台 `killTree`，并补 `detached`
  以便 POSIX 下按进程组杀干净（否则只杀 shell、留下孤儿 dsh 占端口）；
  `verify-cd`/`verify-s2` 里硬编码的 `C:\Users\user\AppData\Local\Temp` 兜底改为 `os.tmpdir()`。

- **M6**：~~Phase H 未进全量脚本~~ → **表述过时**（Phase H 本就在 `run-e2e.mjs` 里）；
  真正的缺口是 CI 覆盖 → **已修**：抽成 `test/e2e/verify-h.mjs` + `pnpm e2e:h`，加入 `fast` job。

### 本地验证状态（务必区分「已验证」与「已改未验」）

本轮开发环境**不允许开监听端口**，因此凡需要 `dsh web` 绑定端口的 e2e 都无法在本地复跑。
请勿把下面第二类当作已验证：

| 状态 | 内容 |
|---|---|
| **已实测验证** | 单测 **62/62**（`pnpm test`，不涉及端口）；runtime-guard 的 import 归因修复（真实 dsh 0.1.5-alpha.1 全程跑通，账本从误报 `include` 变为正确归因 `fixture-bad-import`）；`dshInstall` 修复（`timer` 从"模块无法解析"变为无误报）；`quoteArg` 往返 6/6；web URL 解析、参数安全、**超时无孤儿进程**（见下） |
| **已改但本地未验证** | 各 e2e 脚本需要在 `dsh web` 上跑端到端断言（绑定临时端口）。其中 `pnpm e2e:c` 在端口被禁用**之前**曾 17/17 通过；统一辅助模块重构后未再复跑 |

### 第二轮评审（P1/P2）修复

- **P1-a（属实）`runDsh()` 缺 `detached`**：`compose.mjs` 用 `shell: true` 启动却没建进程组，
  于是 POSIX 下 `killTree` 的 `process.kill(-pid)` 必然失败、退化成 `child.kill()` **只杀 shell**，
  留下孤儿 dsh 占端口/资源。→ 已补 `detached: process.platform !== 'win32'`。
- **P1-b（属实）e2e 辅助实现不一致**：`verify-c` / `verify-cd` / `verify-s3c` / `verify-efg` / `verify-h` /
  `run-e2e` 各自抄了一份 `run()`，其中多数仍用**内联 POSIX 引号拼接**
  （`'"' + a.replace(/"/g,'\\"') + '"'`，Windows cmd 下遇到反斜杠/引号就会错），
  且超时只调 `child.kill()`。→ 抽出 `test/e2e/helpers.mjs`，统一提供
  `run()` / `startServer()` / `parseWebUrl()` / `originOf()` / `shellCmd()`，
  参数转义走 `compose.quoteArg`、清理走 `compose.killTree`、POSIX 统一 `detached`；6 个脚本全部改为复用。
- **P2-a（属实）`shell: true` 解释器展开**：`%` 在 cmd.exe 中**即使位于双引号内也会展开 `%VAR%`**，
  没有可靠转义写法。→ 新增 `assertSafeArg()`：控制字符（含 `\r`/`\n`）一律拒绝；`%` 仅 win32 拒绝；
  `buildCommandLine()` 统一做「校验 + 转义」。顺带修掉一个不一致：**bin 此前未转义**，
  dsh 装在含空格路径下会出错。补 3 条回归测试。
- **P2-b（部分可解）端口改造的验证证据**：把 `parseWebUrl()` 抽成纯函数并补样本测试
  （带 token + LAN 后缀、0.1.0-rc.6 无 token、不得误匹配 `dsh web: opening the default browser…` 提示行），
  这部分**不再依赖端口**即可验证。真正需要真实端口的仍是端到端断言，须在 Windows CI 上跑
  `pnpm e2e:c` / `pnpm e2e:h` / `pnpm e2e:s3c` 并保留日志。
  另补**超时无孤儿进程**回归测试（子进程拉起写心跳的孙进程 → 超时后心跳必须停止），
  直接锁住 P1-a 的修复，且不需要端口。
- **P2-c（评审此条部分不准确）发布元数据**：核实后，三包**早已具备**
  `description` / `author` / `license` / `repository` / `files` 白名单 / `engines` / `publishConfig`，
  且均无 `private: true`（根 package.json 才是 `private: true`）。
  **真实缺口是 4 个包都没有 LICENSE 文件**（`files` 白名单不排除它，但包目录里没有就不会进 tarball）→ 已从仓库根复制 MIT LICENSE。
  另注：Gitleaks pre-commit 存在于**工作区根仓库** `D:\ai的项目`（`core.hooksPath=.githooks`，缺 gitleaks 则 fail-closed），
  但 `dsh-error-tell` 是**嵌套独立仓库**、`core.hooksPath` 未设置，因此它的提交**不会**触发该 hook；
  且本机**未安装 gitleaks**，无法在提交前完成扫描——这是需要人工决定的环境问题。


## 待办问题（未修）

### 严重
- ~~**S3**：maxDisable 只覆盖 boot-guard 路径（runtime-guard/端点无上限），且按累计集合计数会导致熔断自锁。~~
  → **已修**，见上文 B2 / B4（端点此前其实也有上限，真正的缺陷是"按累计集合计数导致自锁"）。

### 中等
- **M1**：~~runDsh shell 拼接（DEP0190）~~ + Windows 进程树不清理（孤儿 dsh 进程占端口）。
  `quoteArg` 的 Windows 转义已修（见 B5）；进程树清理 `killTree`（taskkill /T /F）已在超时/quit 路径调用，
  正常 close 路径仍无兜底清理，未动。
- **M2**：guard 默认 `--port 0` 改变用户端口；`--patch` 未传给 spawn（预检与启动树不一致）。
- **M3**：client-tell 端点静态头防护弱（建议 per-page token + Origin 校验）。
- **M4**：用户手动恢复被账本 active 记录再次覆盖。
- **M5**：~~e2e 固定端口/硬编码 TEMP/taskkill，非 Windows 不可跑~~ → **已修**（端口竞态、taskkill 收敛、硬编码 TEMP 三部分），见上文 M5 条目。
- **M6**：~~Phase H 挂起超时用例未进 run-e2e 全量脚本~~ → **表述过时 + CI 缺口已修**，见上文 M6 条目。
- **M7**：~~对 DSH 私有 API（_initTask/_error/fiber.state）无版本护栏~~ → **已修**（`capabilityReport`），
  且实测确认了它预警的那类静默失效（见上文 B6）。
- **M8**：import 干跑与 dsh 真实加载管线不一致（未动），~~且串行子进程慢~~ → **已修**，改为有界并发（见上文优化）。

### 轻微（已全部处理，2026-08）
- [x] L1 yaml 动态探测 dsh 安装（npm root -g）
- [x] L2 CLI 数字参数校验（非法值 exit 2）
- [x] L3 restore 语义（managed 有记录即成功）
- [x] L4 runtime-guard 与 patch-writer 重复实现 → **暂缓**：抽 `@dsh-error-tell/core` 涉及发布流程，待发布前做
- [x] L5 inject-script 清理（observer disconnect / done 语义 / rowButton 复用）
- [x] L6 删除 client-tell/src/client.js 死代码
- [x] L7 checks 缺 id 行降 warn（不进入禁用路径）
- [x] L8 重启用尽诊断日志
- [x] L9 e2e 消除 DEP0190 + 超时杀进程树
- [x] L10 README/verification 表述修正

## 发布 checklist

- [x] S2/S3 修复后发布 → S2/S3 及后续 B2/B4/B6 均已修（见上文）
- [x] 三包去 private、补 author/repository/description → 核实后**本就已具备**（根 package.json 才是 `private: true`）
- [x] 各包补 files 白名单、engines → 本就已具备
- [x] 各包补 LICENSE 文件 → 本轮补（此前 4 个包目录里都没有，不会进 tarball）
- [x] DSH 版本护栏 + 能力自检 → `capabilityReport()` + `detectDshVersion()`
- [ ] 发布顺序 boot-guard → client-tell（`file:` 改 registry 版本）
- [ ] 版本策略（changesets 可选）
- [ ] **Windows CI 实测 `pnpm e2e:c` / `pnpm e2e:h` / `pnpm e2e:s3c` 并保留日志**（本地端口受限，见上文「本地验证状态」）
- [ ] **决定嵌套仓库的 Gitleaks 门禁**：`dsh-error-tell` 未设 `core.hooksPath`，根仓库 hook 不生效；且本机未装 gitleaks

## 测试盲区

- ~~maxDisable 累计自锁~~ → 已补（熔断增量语义回归 ×1）
- ~~inferFailures 误报用例~~ → 已补（id 前缀碰撞 ×4）
- ~~web URL 解析 / 参数安全 / 超时孤儿进程~~ → 已补（e2e 辅助 ×7）
- [ ] Windows CI 上的端到端证据（端口受限，本地无法覆盖）
- [ ] restore 后真实重启 dsh（S1 修复后应补）
- [ ] 端点 400/403/404/405/超大 body/重复禁用/坏 token
- [ ] 注入脚本在真实失败加载页渲染（Playwright）
- [ ] runtime-guard 的 HMR reload 行为
- [ ] 并发写入（guard CLI 与运行中 dsh 同时写）
- [ ] 非 Windows 平台实跑
- [ ] parsePatchYaml 坏输入矩阵
- [ ] watchUserPatches 热重载真实验证
- [ ] 多 profile 共享 DSH_HOME
