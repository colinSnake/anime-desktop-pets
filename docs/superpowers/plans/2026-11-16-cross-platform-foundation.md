# 跨平台基础实施计划

> 执行方式：本聊天按测试驱动逐项实现；按 requesting-code-review 技能使用独立只读审查，不委派实现，不创建提交。用户已授权更新文档后直接开发；在当前检出中新建 `codex/cross-platform-foundation` 分支，保留既有未提交文档。

**目标：** 交付可构建、可离线验证的 Electron/React/Fastify/Python 诊断基础，不宣称产品完成迁移。
**架构：** Electron 安全桥接到独立 Fastify utility process，后者监督标准库 Python 诊断进程；共享版本化 contracts；React 不获取系统权限和服务凭证。
**技术栈：** TypeScript、React、CSS、Electron、Fastify、Python 3；Node 内建测试运行器与 tsx。
**设计：** `docs/superpowers/specs/2026-11-16-cross-platform-foundation-design.md`。

## 全局约束

- 目标 Windows/macOS/Linux；Linux 首版优先 X11/XWayland，Wayland 明示限制。
- 保留现有 Swift/Python 实现、数据和构建；不启动真实桌宠、不调用真实账号或模型、不安装应用。
- 凭证不入 renderer、参数、日志；仅回环监听；限制来源、Host、请求结构及桥接调用方。
- Python 诊断不是现有 Qt helper；各平台发行包和实际桌面均需后续单独验收。

## 任务 1：契约与服务安全入口

文件：根 `package.json`/`tsconfig.json`/锁文件；`packages/contracts/src/index.ts`；`apps/app-service/src/{server,platform}.ts` 及对应 `test/*.test.ts`。

- [x] 先写能力矩阵和服务鉴权、Host、Origin、方法/参数测试，执行并确认失败。
- [x] 实现 `createService({token, runtime})`、`platformCapabilities(platform, env)`、`isSnapshot(value)`；不提供任意代理接口。
- [x] 重跑测试；真实绑定 127.0.0.1 随机端口验证鉴权入口。

## 任务 2：有界 Python 诊断生命周期

文件：`apps/app-service/src/python-runtime.ts`、`apps/runtime-bridge/{worker.py,test_worker.py}`、服务侧进程测试及 fixture。

- [x] 测试协议版本/固定命令/大小限制/EOF，再测试真实进程成功、缺失解释器、坏响应、超时及关闭中取消。
- [x] 实现 `PythonRuntime.probe()`/`close()` 与有界回收，不导入 Qt、MLX，不读用户数据。
- [x] 确认关闭后子进程实际退出、并发请求不重复创建，错误不泄露输入。

## 任务 3：Electron 安全壳与 React 工作区

文件：`apps/desktop/src/{main,preload,service-process,security}.ts`、`apps/app-service/src/entry.ts`、`apps/workspace-ui/src/{App,client,style}.tsx/ts/css`、各自 tests、构建脚本。

- [x] 先写调用方校验、生命周期及 UI/响应校验测试，确认失败。
- [x] 实现 utility process 引导/退出、安全 preload 和有明确未迁移标记的诊断 UI；构建静态资源，不自动启动 Electron。
- [x] TS 类型检查、全部新测试、生产构建及资源边界检查；不以构建替代真实桌面启动。

## 任务 4：文档与回归

文件：中英文 README、AGENTS、架构/PRD/路线图/本地指南/文档索引/实际验证记录，新跨平台指南。

- [x] 同步“现有实现”和“目标架构”，记录运行命令、最低开发环境及支持边界；保留其他工作新增的模型设计链接。
- [x] 执行新测试与原项目检查；按实际范围运行旧回归，记录命令、退出状态、通过/失败/跳过及未执行边界。
- [x] 检查 diff/空白/忽略项，无提交，无安装，无真实桌面操作。

## 执行记录

2026-11-16：本计划范围内四任务完成；新检查最终为 Node 32 项、Python 4 项、构建冒烟 2 项通过，旧回归 Swift 492/Python 595 项通过。独立只读审查的输出缓冲上界和服务死亡后 worker 回收问题均有失败先行测试及修复。详细命令/退出状态/未执行边界见 `docs/实际验证记录.md`。本计划不包含 Qt/业务/语音迁移或三端发行，下一阶段须另行细化；未创建提交。

## 任务 5：按用户要求切换 pnpm（2026-11-16 继续）

文件：根 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`；两个 service/desktop 包清单、构建脚本、desktop 主入口、构建冒烟及 CI；活跃命令文档。保留历史 npm 验证记录原貌，不再执行 npm。

- [x] 用 `node --test scripts/test-workspace-config.test.mjs` 先复现未固定 pnpm / 缺失显式 workspace 依赖的失败（2 项）。
- [x] 固定 `packageManager=pnpm@10.32.0`，迁移锁文件与脚本；只允许 `esbuild@0.28.2` 构建脚本。
- [x] 服务输出到 `apps/app-service/dist/entry.cjs` 并导出；desktop 以 `workspace:*` 依赖、`createRequire(__filename).resolve("@pet/app-service")` 定位，服务独立解析 Fastify。
- [x] 冒烟先复现旧 `apps/desktop/dist/service.cjs` 残留，构建成功后只清除此旧生成入口；CI 改 pnpm 缓存与 frozen install。
- [x] 在无旧 node_modules 的独立临时副本执行 frozen install 和全部新检查，确认不依赖旧平铺；同步实际证据。

## 任务 6：Qt 接入前必要条件检查

文件：`apps/runtime-bridge/{qt_preflight.py,test_qt_preflight.py}`、`scripts/check-qt-runtime.mjs`、根 `check:qt`、专题文档。

- [x] 先运行预检测试确认缺实现失败；用临时合成源码（内容一旦执行即抛错）覆盖发现/缺失/异常脱敏、Windows IPC 阻塞、Linux 会话、旧 Python/未知平台及 CLI 退出码/4096 字节限制。
- [x] 实现 `inspect_environment(*, repository, platform, environment, python_version, locate_module)` 和本机只读 CLI。只查顶层模块 spec，不导入 Qt/PIL、上游代码或播放器；不连接旧 socket，不安装依赖。
- [x] 默认解释器运行 `pnpm run check:qt`，按实际结果记录阻塞；`test:bridge` 合成回归不要求机器安装 Qt。
- [x] 复核新增源码与文档；执行最终 pnpm 全套、受影响项目检查，记录未执行的真实桌面/三端边界。

## 审查补充任务：启动隔离和失败构建保存

- [x] 先用临时 venv 的 `.pth` / `sitecustomize` 写入临时 marker 复现 `-I` 不能阻止启动钩子；预检改用 `-I -S -B`，显式解释器包目录与 PathFinder，保留包发现且不执行钩子。增加严格报告校验/重建及 2 项 Node 回归。
- [x] 增加暂存构建与普通提升失败逆序回滚；2 项回归验证服务编译失败和第二包提升失败时旧 dist 保留。若恢复失败则保留备份，不自动删恢复证据。
- [x] 服务冒烟验证 Fastify 的服务包本地链接真实路径，清单检查其明确声明，避免根目录遗留兜底。
- [x] 共享系统包 venv 的 true/false 发现回归，先复现遗漏后实现有界配置读取及条件继承；默认 Python 与已有 Python 3.12 均验证。
- [x] 最终检查和独立复核后记录真实结果；不提交、不推送、不启动桌面。
