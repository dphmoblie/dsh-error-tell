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
| **已实测验证** | 单测 **103/103**（`pnpm test`，不涉及端口；含新增 `compose-timeout.test.mjs` 2 条，把 Phase H 依赖的「进程级超时 → `timedOut:true`」兜底分支固定在单测里，不再依赖 dsh 版本的挂起行为）；**`pnpm e2e:d`（Phase D）13/13 全绿，本机 262.9 s**，且同一提交在 CI 上 Phase C/D 均通过——它用的 profile `s2test` 只含 `@deepseek-ai/dsh-base`、不起 `dsh web`，故不受本地禁端口约束；另有**不开端口的 Phase E/G/H 复刻**（`.tmp/verify-e-noport.mjs`：`rows=93 issues=0 errors=0`、无 home patch、**无隔离账本**；`.tmp/verify-g-noport.mjs`：`attempts=3`、两个坏行都进 managed、账本 failCount=2；`.tmp/verify-h-noport.mjs`：`exit=5`、`spawn={code:null,timedOut:true}`、无 home patch、无隔离账本）；runtime-guard 的 import 归因修复（真实 dsh 0.1.5-alpha.1 全程跑通，账本从误报 `include` 变为正确归因 `fixture-bad-import`）；`dshInstall` 修复（`timer` 从"模块无法解析"变为无误报）；`quoteArg` 往返 6/6；web URL 解析、参数安全、**超时无孤儿进程**（见下） |
| **已改但本地未验证** | 需要在 `dsh web` 上跑端到端断言的其余脚本（`pnpm e2e:c` / `e2e:efg` / `e2e:s3c` / `e2e:h`，均须绑定临时端口）；Phase D 在**旧 dsh**（0.1.0-rc.6，import 失败会终止进程）路径下也未复跑过 |

### 本轮：dsh 0.1.7-rc.2 适配（CI 从红转绿）

背景：CI 曾整体变红，根因是上游 **2026-09-22T15:36–39Z 锁步发布**（cordis 4.0.4 / cordis-plugin-hmr 1.0.19 / loader 1.0.5 / timer 1.1.6 / include 1.0.9）。
`dsh@0.1.0-rc.6` 声明 `cordis-plugin-hmr: ^1.0.16`（stable caret，`npm i -g` 无 lockfile 钉不住），
而它启动后**无条件**装载 HMR 服务并调用 `watchUserPatches`，装不上就抛
`dsh: user patch-layer watching requires the Cordis HMR service` 并 exit 1 → 任何 profile 都起不来。
→ CI 的 dsh pin 由 `0.1.0-rc.6` 改为 `0.1.7-rc.2`（该代已重构 HMR 引导，不再需要该服务），并新增「记录 dsh 与 cordis 依赖版本」诊断步骤。

换 pin 后 Phase D 暴露出**两个真实缺陷**（都不是测试写法问题）：

1. **dsh launcher 参数段被截断**（`packages/boot-guard/src/guard.mjs`）：`dsh/lib/bin.js` 的契约是 launcher 只认自己的 flag，
   遇到第一个非自家 flag 就把**后面全部参数原样交给 app**。旧代码把 `--no-open`（web app 的 flag）排在 `--patch` 之前，
   于是 `--patch`（用户覆盖层 + 探针层）**完全没被 launcher 收集**，静默丢弃。
   实测：`dsh --profile s2test --dump-config --no-open --patch probe.yml` →
   `error: config dumps take no app arguments, got "--no-open" "--patch" …`。
   → 新增导出纯函数 `buildDshArgs({profile, patchFiles, probePatchFile, port, quitAfterMs, extraArgs})`：
   launcher 段在前（`--profile` + 全部 `--patch`，探针最后=优先级最高），app 段在后（`--no-open` / `--port` / extraArgs）。
   回归测试 `packages/boot-guard/test/guard-argv.test.mjs`（7 条，含复刻 launcher 截断规则的 `launcherParse`）。

2. **「进程存活」被当成「启动成功」，误恢复从未验证修好的坏行**：dsh 0.1.7-rc.2 起插件 import 失败**不再终止进程**，
   只打一行 `dsh: warning: 1 entry did not activate … failed to import`。
   旧成功分支只看退出码/quit 钩子，于是带探针启动（行被临时启用 → 仍 import 失败但进程活着）被判成功 →
   `restoreQuarantine` 撤销一个从未验证的禁用行（在旧 dsh 上 import 失败是致命的，只看退出码足够）。
   → 新增 `splitUnactivated(stderr, rows, {probeIds, known})` 按 stderr 归因：探针行失败则**剔除探针、保持禁用**并追加一次干净启动；
   非探针行失败则记账 `source: 'boot-guard-survived-boot'`。归因/熔断逻辑收敛到闭包 `attributeFailure()`，
   新增 `rewriteProbe()`。回归测试 `packages/boot-guard/test/guard-survived.test.mjs`（3 条，含 D3 场景）；
   `guard()` 增加 `dshRun` / `compose` 注入缝，使该分支无需 spawn/端口即可覆盖。

3. **apply 阶段失败同样只打 warning**（实测：`dsh: warning: 1 entry did not activate` +
   `fixture-bad-apply (@dsh-error-tell/fixture-bad-apply): Error: … apply 阶段抛错（用于测试）`，进程 30 s 不退出）。
   预检只干跑 import，抓不到 apply 失败 → 只能靠「存活归因」在运行期发现；但旧成功路径一旦归因禁用就立刻 `break` 结束，
   返回的 `ok=true` 其实是「少一行 / 坏一行」的实例（禁用要下一次启动才生效）。
   → 存活归因**新增禁用后按 `restartLimit` 追加一次重启**再交付（与失败路径同一语义，日志 `已归因禁用 … ，重启一次以交付干净实例`）；
   `--restart-limit 0` 时只记账、提示下次启动生效，不额外重启。
   回归测试：`packages/boot-guard/test/guard-survived.test.mjs` 第 3 条（Phase G 语义，无需 spawn/端口）。
   本地复刻真实 dsh（`.tmp/verify-g-noport.mjs`：同一组坏插件，但 profile 只含 `@deepseek-ai/dsh-base`、不起 web、不开端口）
   结果 `ok=true, attempts=3, disabled=[fixture-bad-import, fixture-bad-apply]`，managed 段两行 `disabled: true`，
   账本两条 `failCount=2`（source `boot-guard-survived-boot`）——与 Phase G 的断言逐条对应。

4. **预检把官方子路径行误判为 import 失败**（`packages/boot-guard/src/checks.mjs`）：
   `dsh-base` 里有一行 `name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'`（**子路径 spec**）。
   预检先在 profile 目录干跑 import；e2e 沙箱**不链接**官方包（`linkOfficialDsh()` 只在设了 `DET_DSH_PREFIX` 时生效），
   所以官方行本该回退到 dshInstall 锚点再干跑一次 —— 但 `isTargetUnresolved()` 只拿**完整 spec** 去匹配
   `Cannot find package '<x>'`，而 Node 在引号里放的永远是**包根名**（`'@deepseek-ai/dsh-tool-subagent-control'`，不含 `/list-agents`）
   → 匹配不上 → 不回退 → 报 `[error/import] … Cannot find package '@deepseek-ai/dsh-tool-subagent-control'`。
   后果不只是测试红：该行属保护名单，**只记账**，于是在一个完全干净的 profile 上凭空写出隔离账本
   （CI 的 `[E] 未创建隔离账本（零副作用）` 失败、`[G] 账本含 2 条活动中记录` 变成 3 条，都是这一条引起的）。
   → 新增导出 `resolutionNames(name)`（完整 spec + 带子路径时的包根名），`isTargetUnresolved` 在候选集上逐个匹配；
   P1-3 的判据不变（内部传递依赖缺失时报的是**别的**包名，两个候选都命中不了）。
   实测：修复前 `isTargetUnresolved(子路径报错) = false`，修复后 `checkImport(profile → dshInstall) = {ok:true}`；
   单测 `packages/boot-guard/test/checks.test.mjs` +2 条（子路径判定、`resolutionNames`）。

5. **预检超时是负载抖动的假失败**：一次干跑要并发起 ~90 个 node 进程，机器临时繁忙时单行会撞上 20 s 上限
   （本机实测出现过 `[error/timeout] repeat-tool-reminder: import 超时(20000ms)`，但单独导入同一包只需 35 ms）。
   超时会被记成「该行失败」——官方行凭空写账本、第三方行最终被误禁用。
   → `checkImport()` 同一锚点**重试一次**，两次都超时才上报（错误文案写明「重试 1 次后仍超时」）；
   被放弃的旧进程标记 `abandoned`，其 exit/error 事件不再进入判定。回归测试 +1 条（marker 控制「首次挂起、重试成功」）。

6. **S3C 的就绪探测用裸 `origin + '/'`，在会话认证下永远拿不到 200**（CI run 36145730009 首次真正跑到该步骤）：
   诊断输出里 dsh 已打印 `dsh web: http://127.0.0.1:63053/?token=YkXl…`、`exitCode: null`（宿主活着）、stderr 为空，
   却整整 90 秒探测不到 200，而同一 origin 的 `/api/error-tell/disable` 返回 200、第二次 429（熔断逻辑本身全对）。
   根因：dsh 0.1.x 的首页要**会话认证**——带 token 的首页先 303 → `Set-Cookie` → 再用 cookie 访问；
   Phase C 一直是这么做的（断言文案里的「已换会话 cookie」），S3C 抄了旧写法。
   → 把该逻辑抽到 `test/e2e/helpers.mjs` 的 `makePageFetch(server)` / `waitForWebReady(server)`，
   `verify-c.mjs` 与 `verify-s3c.mjs` 共用（顺带消化 P1-b 类重复实现）；`run` 不再使用，两个脚本的 import 一并收敛。

7. **Phase H 的「谁先到」竞态**（CI run 36147631666，H 首次真正跑到）：失败信息是
   `✖ FAIL: [H] 挂起超时熔断（exit 5, timedOut）—— exit=5` —— 退出码对、零副作用断言也过，
   只有 `spawn.timedOut === true` 不成立。0.1.7-rc.2 上「挂起」有两种收场方式，取决于谁的看门狗先到：
   守卫自己的进程级超时（`spawn={code:null,timedOut:true}`）或 dsh 自行异常退出（`spawn={code:<非0>,timedOut:false}`）。
   → 用例要覆盖的是**守卫的兜底**那一支，故把 `--timeout-ms` 从 20 s 压到 **8 s**（明显小于 dsh 自己的看门狗 ≈20 s）消除竞态；
   机制层另有单测 `packages/boot-guard/test/compose-timeout.test.mjs` 固定 `runDsh` 的 `timedOut` 分支，不再依赖 dsh 的挂起行为。
   `verify-h.mjs` 同时在断言前打印 `parsed/exit/ok/spawn` 与 guard 输出尾部，避免下次只剩一句没有证据的 FAIL。

时间预算：0.1.7-rc.2 下 D1/D2 的失败不再"秒退"，只能等守卫自己的超时窗口，故 `test/e2e/verify-d.mjs`
把 D1/D2 的 `--timeout-ms` 从 90 s 降到 **30 s**、D3 的 quit 窗口从 90 s 降到 **60 s**（dry-run 的超时上限放到 240 s，
本机实测该步骤 73 s：94 行逐行 import 干跑、并发 4）。整套 Phase D 由 444.7 s 降到 262.9 s。

Phase E/F/G 与 H 的**用例上限（不是被测行为）**同步放宽，因为「逐行 import 干跑」预检在 CI 上约 25–30 s，
且修好「归因禁用后必须重启交付」后 Phase G 由 2 次启动变成 3 次启动（CI 实测 2 次启动段 87 s ⇒ 3 次约 130 s+）：
`verify-efg.mjs` E `60000 → 120000`、G `120000 → 300000`；`verify-h.mjs` `90000 → 180000`。
不这么改，CI 会在第 3 次启动中途按用例上限杀掉 guard（没有最终 JSON ⇒ `attempts=undefined` 的假失败）。

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

### 第三轮评审（21 项缺陷报告）修复

逐条先验证再改。**其中 3 条经核实与事实有出入**，已在下面标注。

#### P1（7 项，全部属实并已修）

1. **`--port` 被静默忽略** — `bin` 解析了 `port` 却从未传给 `guard()`。已传参，并区分
   「未传入」（不向 dsh 传 `--port`，沿用 dsh 默认端口）与「显式 `--port 0`」；
   `guard()` 默认值由 `0` 改为 `undefined`（原来的 0 会让 CLI 永远覆盖成临时端口，与文档矛盾）。
   数字参数校验同时改为**整数 + 范围**（`--port` 限 0..65535）。
2. **重启归因绕过 `maxDisable`** — precheck 只校验一次，重启路径 `add` 后直接 `writeManaged`。
   新增 `canAddDisable()` 并在每轮归因时实时校验，超限只记账不落盘。
3. **import fallback 掩盖 profile 内部依赖损坏** — 原来只要错误含 `Cannot find` 就回退到
   `dshInstall`。新增 `isTargetUnresolved()`：**只有报的正是目标包名**才回退；
   若报的是别的包名，说明是目标包内部的传递依赖缺失，必须如实上报。
   补端到端回归：profile 内目标包存在、内部依赖缺失 + 全局有同名健康包 → 必须判失败。
4. **账本/patch 跨进程丢失更新** — ⚠️ **报告声称的复现未能在真实调用路径重现**：
   我用 50 个子进程直接打 `addQuarantine`+`syncDisable` 得到 **50/50 无丢失**（窗口只有微秒级）；
   把窗口人为放大到 20ms 后才出现丢失（48/50）。**缺陷机制真实存在，但触发概率取决于调度抖动**。
   仍按缺陷修复：新增 `withFileLock()`（用 `mkdir` 原子性做的跨进程锁，含陈旧锁强拆与超时）
   覆盖「读→改→写」整段；临时文件改**随机后缀**（原来固定 `.tmp`，并发写者会互相 rename 对方的临时文件）；
   补跨进程回归（持锁放大窗口 → 6/6 不丢；另测锁不可重入）。
5. **runtime-guard 批量熔断误删历史禁用项** — 原实现遍历 `seen` 删除所有位于 managed 的 id。
   改为 `writtenThisRun` 只记**本进程真正写入**的行，抽出 `rollbackWritten()` 并补回归。
6. **全新 DSH_HOME 写入失败** — `writeManaged()` 补 `mkdirSync(dirname(patchPath), {recursive:true})`，补回归。
   说明：`recordFailure` 路径上账本先写会顺带建目录，所以 ENOENT 实际出现在
   「先写 managed 再记账」的调用方（如 client-tell 的 disable 端点），属真实缺陷。
7. **损坏账本被静默当空账本** — 改为只有 `ENOENT` 返回空账本；JSON/结构损坏时**先备份**
   （`quarantine.json.corrupt-<时间戳>`）再重置，并 `emitWarning`。
   **未采纳"拒绝写入"**：账本是状态文件而非用户配置，一个损坏的状态文件不该让守卫彻底失效；
   备份已保证原数据不丢，调用方可用 `lastCorruptLedgerBackup()` 查备份路径。

#### P2（14 项：12 项已修 + 2 项需人工决定）

- **⑧ `seen` 过早去重** → pending/环境类错误不占用去重位。补回归：先来的 pending 不得让后续真实失败被跳过
  （该用例在原实现下会失败）。
- **⑨ NaN/小数熔断配置** → core 新增 `nonNegativeInt()`，CLI 用整数+范围校验；
  core / runtime-guard / client-tell 三处 `Number(env)` 全部替换。
  注意 `Number('') === 0` 不是 NaN，空串必须显式判掉（单测抓到过）。
- **⑩ checks 超时未杀进程树** → `child.kill()` 改 `killTree()`，并补 POSIX `detached`。
- **⑪ `stdout.includes('OK')` 假阳性** → 改为**每次唯一的哨兵 + 退出码必须为 0**。
  补回归：目标包先打印 `OK` 再抛错必须判失败。
- **⑫ 非字符串 id/name 抛 TypeError** → `escapeRegExp` 先 `String()`，循环里显式跳过 null/undefined。补回归。
- **⑬ 包名边界缺常见标点** → 右侧边界补 `, ; . ] } ! ?`。补回归（8 种标点）。
- **⑭ `skipPackages` 字段不一致** → checks 比对的是 `row.name`，原来只传了行 id；新增 `SELF_PACKAGES` 一并传。
- **⑮ `probePackage` exports 形态** → 抽出 `hasHostEntry()`，兼容 exports 字符串/数组/`"."` 条件导出/顶层条件导出。
- **⑯ `detectDshInstall` 忽略传入 env** → 透传 `guard({env})`（自定义 npm prefix / 隔离安装才探测得到）。
- **⑰ rowId 无校验** → core 新增 `isValidRowId()/assertValidRowId()`（字符白名单 + 200 上限），
  用于 `syncDisable`、`recordFailure`；端点侧非法直接 400（同时避免回显任意输入）。补回归。
- **⑱ 端点缺 Origin 校验** → 新增 `isAllowedOrigin()`（回环 host 白名单）。
  **只在 Origin/Referer 存在时校验**：缺失时放行，否则 curl/e2e 会被全部拒掉，token 仍是主防线。
- **⑲ CI 只支持手动触发** → 补 `push`(main) 与 `pull_request`；`full` 全链路 job 仍限手动。
- **㉑ README 版本号不一致** → `client-tell 0.1.7` → `0.1.8`。
- **⑳ Gitleaks 门禁** → ⚠️ **报告部分不准**：hook **确实存在**，但在**工作区根仓库**
  （`core.hooksPath=.githooks`）；真实缺口是 `dsh-error-tell` 属嵌套独立仓库、`core.hooksPath` 未设置，
  因此它的提交不触发扫描；且本机未装 gitleaks。
  已提供仓库自带 `.githooks/pre-commit` + `scripts/setup-hooks.mjs`：
  **未检测到 gitleaks 时只报告、不改配置**（hook fail-closed，擅自接上会锁死提交）。需人工决定是否接入。

测试：单测 62 → **83 项**全绿（新增 21 项，全部针对上述缺陷）。
未验证项与第二轮相同：需要真实端口的端到端断言本地无法复跑。


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
