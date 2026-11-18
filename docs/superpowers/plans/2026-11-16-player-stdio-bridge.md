# 播放器 stdio 桥接实施计划

> 2026-11-16 后续优先级修正：用户要求先完整迁移现有 macOS 功能，并按新设计改善页面；Windows/Linux 播放器阻塞保留但暂缓移植，不作为 macOS 业务迁移前置。本文历史实现范围/验证不变，后续顺序以[macOS 功能迁移清单](../../macOS功能迁移清单.md)为准。

> 执行方式：本聊天测试驱动实现；按 requesting-code-review 进行独立只读复核。用户已明确继续推进；不委派实现、不创建提交、不启动真实桌面。

**Goal:** 交付显式可控、独立 profile、自有进程回收的单宠开发桥接，实际播放器平台门禁真实保留。
**Architecture:** React/Electron/Fastify 固定动作，Node 会话监督与匿名管道，Python GUI 主线程生命周期装配复用现有 factory；不复用旧 Unix IPC 或 registry/fcntl。
**Tech Stack:** pnpm 10.32.0 / TypeScript / Fastify / React / Python 3.11+ / PySide6。
**Spec:** `docs/superpowers/specs/2026-11-16-player-stdio-bridge-design.md`。

## 全局约束

- 保留所有既有未提交工作；不改旧冻结 helper 输入、字体、真实用户资料或正常运行进程。
- 默认未配置，不自动启动；实际 prepared 播放器只在 macOS 开放，其余系统明确 blocked。
- Qt 对象与开始/停止留 GUI 线程；stdin 仅入有界队列。进程故障不得清理外部进程。

## 任务 1：Python 固定协议及 Qt 生命周期

文件：`apps/runtime-bridge/player_protocol.py`、`player_worker.py`、`player_adapter.py`；标准库协议测试、独立 Qt 离屏测试；guardian 的显式 player 回收预算。
接口：首帧 `bootstrap` 带 version/session/config，后续固定 session/id/status/stop 请求；回复固定 version/id/ok/phase，不传路径或异常。适配器 `begin(on_ready,on_failed,on_stopped)` / `stop()`。

- [x] 测试先行：未知命令、重复字段、坏版本/凭证/路径、超限帧、EOF；缺实现时确认失败，再实现严格解析。
- [x] 实现主线程 Qt 装配，复用 prepared factory，禁用账号/语音/声音/上游菜单；合成 tiny WebP 与隔离 HOME 离屏验证首帧 ready、重复停止和解码回收。
- [x] guardian 的 player 模式给 GUI 清理有界宽限；保留原诊断时限与回归。

## 任务 2：Node 播放器监督与受限服务

文件：`apps/app-service/src/player-runtime.ts`、测试夹具及测试；contracts、server/entry、desktop service bootstrap。
接口：`PlayerController.snapshot(): PlayerSnapshot`、`start()/stop()/close(): Promise<...>`；`PlayerSnapshot` 只有 kind/status/detail。Fastify `POST /v1/player/start|stop` 只接受空对象；配置仅父 IPC 引导。

- [x] 先测试未配置/平台门禁、真实标准库夹具启动/停止、并发/取消、错误脱敏、协议限长、异常退出和父服务死亡回收，确认缺实现失败。
- [x] 实现白名单环境、独立每会话 profile、固定 worker/guardian 路径、匿名 stdio 会话鉴权和有界关闭；不复用旧资料。
- [x] 服务纳入固定动作和关闭门禁；测试 HTTP 拒绝额外路径/任意命令/浏览器来源，原诊断仍独立工作。

## 任务 3：开发壳/界面及实际构建

文件：desktop main/preload/service-process，UI App/client，构建脚本与 smoke，根 pnpm 测试入口。
接口：preload `startPlayer()/stopPlayer()` 均无参；snapshot 的可选 player 字段严格校验，不破坏已有诊断快照。

- [x] 先测新动作/状态/无配置禁用，再实现显式开始停止及未集成声明；真实桌面不启动。
- [x] 构建复制新 Python 模块并验证产物；仍暂存构建/失败回滚。
- [x] 完整 pnpm 检查、已有 Python 3.12 的专用离屏测试及受影响旧回归；独立只读审查。

## 任务 4：文档与验证证据

- [x] 同步中英文 README、AGENTS、专题、路线图与实际验证记录；说明开发参数、macOS 门禁、独立 profile、禁用能力、Windows/Linux 未验收和下一步。
- [x] 记录实际命令、退出、通过/失败/跳过；无提交/推送，无真实桌面、模型、安装、语音或发布验收。


## 本轮验证结果

2026-11-16，本机最终 pnpm 检查 86 项（2 workspace + 4 tooling + 52 Node + 24 Python + 4 build smoke）通过，TS/生产资源构建通过；专用合成 Qt 离屏 6、旧 adapter 45、旧 runtime 159、项目检查 33 通过。旧 runtime 初轮 1 随机覆盖断言失败已如实记录并固定测试随机源，未改生产概率。默认 Qt 预检仍退出 2（缺 PySide6），可信本机 venv 预检退出 0。三项审查发现已增加先红测试与修复，并完成定向复核，细节和未执行边界见实际验证记录。没有真实桌面、三系统运行、字体/素材发布、安装、账号或语音验收；没有提交或推送。
