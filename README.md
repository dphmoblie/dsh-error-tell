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
- **运行时看门狗**（runtime-guard bundle）：捕获 apply/import 失败，在进程退出**之前同步**写账本 + 禁用，重启后生效；
- **浏览器一键恢复**（client-tell）：加载页自动注入「禁用并重载」按钮 + `POST /api/error-tell/disable` 端点，刷新即恢复；
- **隔离账本**：每次禁用的行、包名、阶段、错误、来源均可审计；`restore` 一键回滚；
- **防误杀**：`maxDisable` 熔断（默认 50）、自我禁用保护、CSRF 防护头、重启循环上限。

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
pnpm test          # 单元测试
pnpm e2e:cd        # 分段 e2e（client-tell + import 预检）
pnpm e2e:efg       # 分段 e2e（幂等性 / YAML 损坏 / 多坏插件）
```

### 方式二：作为 bundle 装入你的 profile

```bash
# 在 profile 里安装 runtime-guard 与 client-tell（file: 或发布到 npm 后按包名）
cd ~/.dsh/profiles/web
pnpm add @dsh-error-tell/runtime-guard @dsh-error-tell/client-tell
# 把两个包加入 package.json 的 dsh.profile.bundles，重启 dsh web 生效
```

> ⚠️ 当前各包 `private: true`，发布到 npm 前请先去掉并按依赖顺序发布（boot-guard → runtime-guard / client-tell）。

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
| `--max-disable <n>` | `50` | 单次最多自动禁用行数（熔断防误杀） |
| `--timeout-ms <n>` | `120000` | dsh 子进程超时（apply 挂起时熔断） |
| `--port <n>` | `0` | 传给 dsh 的端口 |

## 落盘位置

| 文件 | 说明 |
|---|---|
| `$DSH_HOME/cordis.patch.yml` | home 级补丁；`# --- dsh-error-tell managed ... ---` 段为自动管理区（请勿手改） |
| `$DSH_HOME/state/dsh-error-tell/quarantine.json` | 隔离账本（每次禁用的审计记录） |

环境变量：`DSH_HOME`（默认 `~/.dsh`）、`DSH_ERROR_TELL_QUIT_AFTER_MS`（测试钩子，正常启动后自动退出，勿在生产使用）。

## 安全设计

- 禁用端点要求 `x-dsh-error-tell: 1` 头（防跨站请求）；
- 拒绝禁用自身与 `error-tell-*` 守护行；
- `maxDisable` 熔断：待禁用行数超限时拒绝修改任何配置；
- 看门狗不递归、不禁自己、失败只记日志；
- **连续 2 次失败才禁用**（账本 failCount，`--fail-threshold` 可调），瞬态失败不会被永久封杀；
- **启动探针自动恢复**：已禁用行每次启动临时启用真实加载，成功即自动解除禁用；
- **web 管理面板**：正常页面自动显示被禁用插件列表，一键恢复（`/api/error-tell/status` + `/restore`）；
- 重启循环有上限，无法从 stderr 归因时熔断不循环；
- 所有自动改动都可审计、可 `restore` 回滚。
- 说明：`dsh --dump-config` 预检会触发 dsh 自身的模块 heal（创建 `profiles/node_modules`），属 dsh 行为；guard 本身不写任何配置。

## 验证记录

- 单元测试 7 项：YAML `!!js` 容错 / 账本 / managed 段幂等 / 熔断 / stderr 归因 / 注入脚本 VM ×2
- e2e Phase A–H：坏插件 → 启动失败 → 自动禁用 → 重启成功；runtime-guard 进程退出前落盘；client-tell 端点 + 组合图排除；import 预检拦截；幂等性（零副作用）；YAML 损坏友好失败；多坏插件；挂起超时熔断
- 详见 [docs/verification.md](docs/verification.md)

## 开发

```
packages/
  boot-guard/        # 预检 CLI + 重启包装（bin: dsh-error-tell）
  runtime-guard/     # 宿主看门狗 bundle（dsh.bundle.patch）
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
- [ ] 发布 npm（先发布 boot-guard）
- [ ] 真实用户环境试点

## License

MIT
