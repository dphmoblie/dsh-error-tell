# 技术评审报告（子代理独立评估）

> 评审时间：2026-08（HEAD fd7ad06 前后）；评审对象：三层设计 + e2e + CI。
> 评审方法：对照本机 DSH @deepseek-ai/dsh@0.1.0-rc.6 源码逐一核实机制，并做了 3 项实测（单测 7/7、restore 空块复现、干净 profile 预检 0 误报）。

## 总体结论

方向正确、机制落地扎实（评审者对 DSH rc.6 机制判断均经源码核实），但存在 **1 个会砸掉启动的恢复流程缺陷**（S1，已修复）+ 若干误杀/安全/发布问题。

## 已修复

- **S1（严重）**：restore 清空 managed 段后生成注释-only patch 导致 `dsh web` 无法启动 → 已修复：ids 为空且文件仅含 managed 段时删除文件，否则仅移除该段；补单测。
- **S4（严重）**：stderr 归因子串匹配误杀面大 → 已修复：行首 `name:` 精确格式 + 包名边界 + 显式 id 引用三种精确匹配；补单测（含"不应命中"用例）。

## 待办问题（未修）

### 严重
- **S3**：maxDisable 只覆盖 boot-guard 路径（runtime-guard/端点无上限），且按累计集合计数会导致熔断自锁。

### 中等
- **M1**：runDsh shell 拼接（DEP0190）+ Windows 进程树不清理（孤儿 dsh 进程占端口）。
- **M2**：guard 默认 `--port 0` 改变用户端口；`--patch` 未传给 spawn（预检与启动树不一致）。
- **M3**：client-tell 端点静态头防护弱（建议 per-page token + Origin 校验）。
- **M4**：用户手动恢复被账本 active 记录再次覆盖。
- **M5**：e2e 固定端口/硬编码 TEMP/taskkill，非 Windows 不可跑。
- **M6**：Phase H 挂起超时用例未进 run-e2e 全量脚本（文档需与脚本一致）。
- **M7**：对 DSH 私有 API（_initTask/_error/fiber.state）无版本护栏。
- **M8**：import 干跑与 dsh 真实加载管线不一致，且串行子进程慢。

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

## 发布 checklist（未做）
- [ ] S2/S3 修复后发布
- [ ] 三包去 private、补 LICENSE/author/repository/description
- [ ] 发布顺序 boot-guard → client-tell（file: 改 registry 版本）
- [ ] 各包补 files 白名单、engines
- [ ] DSH 版本护栏 + 能力自检
- [ ] 版本策略（changesets 可选）

## 测试盲区（未做）
- restore 后真实重启 dsh（S1 修复后应补）
- 端点 400/403/404/405/超大 body/重复禁用/坏 token
- 注入脚本在真实失败加载页渲染（Playwright）
- runtime-guard import 失败路径/HMR reload 行为
- 并发写入（guard CLI 与运行中 dsh 同时写）
- inferFailures 误报用例（已部分补）
- maxDisable 累计自锁
- 非 Windows 平台
- parsePatchYaml 坏输入矩阵
- watchUserPatches 热重载真实验证
- --patch 覆盖层与 spawn 不一致
- 多 profile 共享 DSH_HOME
