# dsh-error-tell

![CI](https://github.com/dphmoblie/dsh-error-tell/actions/workflows/ci.yml/badge.svg)

> DSH 插件自检/守护：在 `dsh web` 启动时检测其他插件的加载/激活问题，把问题插件**持久化禁用**（写入用户补丁层 `disabled: true`），让 dsh web 正常打开，并提供隔离账本（quarantine）与一键恢复。

## 为什么需要它

DSH 的启动策略是 fail-loud：

- **宿主侧**：任一插件 import/apply 失败会让 `dsh web` 进程直接退出（`installFailLoud`），网页根本起不来；
- **浏览器侧**：`dsh-client-web` 一次性 settle，任一客户端插件失败会让加载页停在 "Failed to load plugins"，UI 不挂载。

同树的插件**救不了当次启动**（树已整体回滚）。所以本项目的形态是：**检测 → 落盘禁用 → 重启/刷新**，而不是"启动时互救"。

## 功能特性

- **启动预检**（boot-guard）：组合配置 → 静态检查（重复 id / 缺 name）→ import 干跑（子进程隔离）→ 发现问题直接禁用，坏插件根本不进启动流程；
- **自动重启包装**：`dsh web` 失败后从 stderr 归因插件名 → 追加禁用 → 重启（限次 + 熔断，无法归因不循环）；
- **运行时哨兵**（runtime-guard bundle）：捕获 apply/import 失败，在进程退出**之前同步**写账本 + 禁用，重启后生效；
- **浏览器一键恢复**（client-tell）：加载页自动注入「禁用并重载」按钮 + `POST /api/error-tell/disable` 端点，刷新即恢复；
- **管理面板交互**：徽标可拖拽，面板锚定在徽标旁并跟随移动；历史记录显示每个插件的**功能描述**（package.json description）、包名与失败原因，方便使用的人排错；
- **设置页「错误哨兵」分区**（客户端模块）：dsh 设置左侧新增分区，可**读取全部插件状态**（运行中/已禁用/挂载失败/用户层禁用 + 功能描述 + 哨兵历史），并对任意插件**手动禁用/恢复**（走同一安全阀：保护名单拒禁、maxDisable 熔断、只写 managed 段、热重载 1-2 秒生效）；
- **隔离账本**：每次禁用的行、包名、阶段、错误、来源均可审计；`restore` 一键回滚；
- **防误杀**：`maxDisable` 熔断（默认 5）、环境/批量失败过滤、自我禁用保护、CSRF 防护头、重启循环上限。

## 架构（三层）

```
┌─ boot-guard（CLI，主防线）─────────────────────────────┐
│  dump-config → 检查 → 写 managed 段 → spawn dsh web   │
│                   失败归因 → 追加禁用 → 重启(限次)      │
└───────────────────────────────────────────────────────┘
┌─ runtime-guard（宿主 bundle，辅防线）──────────────────┐
│  internal/status + _initTask + 兜底扫描 → 同步落盘      │
└───────────────────────────────────────────────────────┘
┌─ client-tell（浏览器，用户闭环）───────────────────────┐
│  tapIndex 注入按钮 → POST /api/error-tell/disable      │
│  → watchUserPatches 热重载 → 刷新即恢复正常            │
└───────────────────────────────────────────────────────┘
```

详见 [docs/architecture.md](docs/architecture.md) 与 [docs/plan.md](docs/plan.md)。

## 安装

### 方式一：本地仓库开发（推荐先体验）

```bash
git clone https://github.com/dphmoblie/dsh-error-tell.git
cd dsh-error-tell && pnpm install
node scripts/setup-hooks.mjs   # 可选：接入 Gitleaks 提交门禁（需先安装 gitleaks）
pnpm test          # 单元测试
pnpm e2e:cd        # 分段 e2e（client-tell + import 预检）
pnpm e2e:efg       # 分段 e2e（幂等性 / YAML 损坏 / 多坏插件）
pnpm e2e:h         # 分段 e2e（apply 挂起 → 进程级超时 → 熔断）
```

### 方式二：作为 bundle 装入你的 profile

```bash
# 在 profile 里安装 runtime-guard 与 client-tell（file: 或发布到 npm 后按包名）
cd ~/.dsh/profiles/web
pnpm add @dsh-error-tell/runtime-guard @dsh-error-tell/client-tell
# 把两个包加入 package.json 的 dsh.profile.bundles，重启 dsh web 生效
```

> 发布状态：已发布 core 0.1.2 / boot-guard 0.1.2 / runtime-guard 0.1.2 / client-tell 0.1.8（MIT）。注意：client-tell 必须用 `pnpm publish`（自动把 `workspace:*` 依赖转换为具体版本）；0.1.6 因误用 `npm publish` 而依赖未转换，已废弃。

## 使用

```bash
# 预检 + 启动（失败自动禁用并重启，最多 restart-limit 次）
dsh-error-tell guard --profile web --restart-limit 2

# 只做预检，不启动、不写配置
dsh-error-tell guard --dry-run

# 查看隔离账本 / 当前禁用的插件
dsh-error-tell status
dsh-error-tell quarantine

# 恢复某个被禁用的插件
dsh-error-tell restore <rowId>
```

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--profile <name>` | `web` | 要守护的 profile |
| `--patch <file>` | - | 附加 patch 覆盖层（可重复） |
| `--dry-run` | `false` | 只检查并打印计划，不启动不落盘 |
| `--restart-limit <n>` | `2` | 失败归因后的最大重启次数 |
| `--max-disable <n>` | `5` | 单次最多自动禁用行数（熔断防误杀，`DSH_ERROR_TELL_MAX_DISABLE` 可覆盖） |
| `--timeout-ms <n>` | `120000` | dsh 子进程超时（apply 挂起时熔断） |
| `--port <n>` | `0` | 传给 dsh 的端口 |

## 落盘位置

| 文件 | 说明 |
|---|---|
| `$DSH_HOME/cordis.patch.yml` | home 级补丁；`# --- dsh-error-tell managed ... ---` 段为自动管理区（请勿手改） |
| `$DSH_HOME/state/dsh-error-tell/quarantine.json` | 隔离账本（每次禁用的审计记录） |

环境变量：`DSH_HOME`（默认 `~/.dsh`）、`DSH_ERROR_TELL_QUIT_AFTER_MS`（测试钩子，正常启动后自动退出，勿在生产使用）、`DSH_ERROR_TELL_ALLOW_PROTECTED=1`（紧急放行白名单）、`DSH_ERROR_TELL_BATCH_THRESHOLD`（批量失败熔断阈值，默认 5）、`DSH_ERROR_TELL_PROTECT_EXTRA`（追加保护，逗号分隔；`@scope/` 按包名前缀，其余按行 id 或包名精确匹配）。

## 自动禁用白名单（防误杀）

2026-08 事故：哨兵一次性禁用了 **20 个系统组件**（`api-gateway`/`session`/`workspace`/`token-meter`/`subagent`/`permission`…），结果是**页面能打开但完全无法对话**。事后加了白名单，但最初只枚举了 67 个 id；拿真实 profile 一量（231 行），**134 行官方包**（`tools`/`agent-loop`/`commands`/`skill`/`ui-chat`/`ui-conversation`/`web`/`mcp-resources`…）仍在名单之外，随时可能被误杀。现在分三层：

| 层 | 范围 | 效果 |
|---|---|---|
| 1 | `PROTECTED_IDS`（70 条精确 id，含 2026-08 事故全清单） | 官方与少数第三方关键行，永不自动禁用 |
| 2 | `PROTECTED_SCOPES = ['@deepseek-ai/']`（官方发行作用域） | 新增官方插件自动获得保护，不必维护名单 |
| 3 | 哨兵自身行/包 + `cordis:` 结构行 + `DSH_ERROR_TELL_PROTECT_EXTRA` | 防自我禁用；用户可自行追加 |

命中白名单的行**只写隔离账本 + 报警，绝不写 managed 禁用**。设置页的手动禁用另走窄名单（`isManuallyProtected`），官方行仍允许人工禁用。

代价：官方插件若真的失败，哨兵不再自动禁用（只记账报警），需人工处理或临时设 `DSH_ERROR_TELL_ALLOW_PROTECTED=1`。第三方社区包不受影响，仍会被自动隔离——这是哨兵的主要用途。

审计命令：`node scripts/audit-whitelist.mjs [loader-dump.yml]`，期望「官方包裸奔行 = 0」。

## 安全设计

- 禁用端点要求 `x-dsh-error-tell: 1` 头（防跨站请求）；
- 拒绝禁用自身与 `error-tell-*` 守护行；
- `maxDisable` 熔断：待禁用行数超限时拒绝修改任何配置；
- 哨兵不递归、不禁自己、失败只记日志；
- **连续 2 次失败才禁用**（账本 failCount，`--fail-threshold` 可调），瞬态失败不会被永久封杀；
- **启动探针自动恢复**：已禁用行每次启动临时启用真实加载，成功即自动解除禁用；
- **web 管理面板**：正常页面自动显示被禁用插件列表，一键恢复（`/api/error-tell/status` + `/restore`）；
- 重启循环有上限，无法从 stderr 归因时熔断不循环；
- 所有自动改动都可审计、可 `restore` 回滚。
- 说明：`dsh --dump-config` 预检会触发 dsh 自身的模块 heal（创建 `profiles/node_modules`），属 dsh 行为；guard 本身不写任何配置。

## 验证记录

- 单元测试 83 项：core + boot-guard + runtime-guard + 注入脚本 VM ×7 + meta 解析 ×4 + 客户端模块 VM ×3（设置分区注册契约）+ runChecks 干跑编排 ×5 + Windows 参数转义 ×6 + 熔断增量语义回归 ×1 + cause 链归因 ×4（`culpritOf`/`stageOf`）+ e2e 辅助 ×7（web URL 解析 / 参数安全 / **超时无孤儿进程**）+ 并发与账本回归 ×21（跨进程锁 / 损坏账本备份 / 全新 DSH_HOME / 回退条件 / 干跑假阳性 / Origin 校验 / rowId 校验 …）
- e2e Phase A–H：坏插件 → 启动失败 → 自动禁用 → 重启成功；runtime-guard 进程退出前落盘；client-tell 端点 + 组合图排除；import 预检拦截；幂等性（零副作用）；YAML 损坏友好失败；多坏插件；挂起超时熔断
- 详见 [docs/verification.md](docs/verification.md)

## 开发

```
packages/
  boot-guard/        # 预检 CLI + 重启包装（bin: dsh-error-tell）
  runtime-guard/     # 宿主哨兵 bundle（dsh.bundle.patch）
  client-tell/       # 双面包：tapIndex 注入 + 禁用端点
  test-fixtures/     # 坏插件工厂（apply / import / client / hang）
test/                # e2e（run-e2e 全量 + verify-cd/efg 分段）+ 注入脚本 VM 测试
docs/                # plan / architecture / verification
.github/workflows/  # CI：fast（单测+分段 e2e）+ full（全链路 A-H）
```

## Roadmap

- [x] M0 骨架 + 禁用通道验证
- [x] M1 boot-guard（预检/账本/patch-writer/重启包装）
- [x] M2 runtime-guard（同步落盘）
- [x] M3 client-tell（注入脚本 + 禁用端点）
- [x] M4 用例矩阵 + 熔断 + CI
- [x] S2 评审修复：连续失败判定 + 探针自动恢复 + web 管理面板恢复
- [x] 发布 npm（core/boot-guard/runtime-guard/client-tell 0.1.x）
- [ ] 真实用户环境试点

## License

MIT
