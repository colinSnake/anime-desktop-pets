# 跨平台播放器 stdio 桥接增量

> 2026-11-16 后续优先级修正：用户要求先完整迁移现有 macOS 功能，并按新设计改善页面；Windows/Linux 播放器阻塞保留但暂缓移植，不作为 macOS 业务迁移前置。本文历史实现范围/验证不变，后续顺序以[macOS 功能迁移清单](../../macOS功能迁移清单.md)为准。

用户已接受 TS/Python 长期架构，并要求继续推进控制通道与 Qt 生命周期；本增量沿此方向实现，不重开语言/框架选择。包管理器仅 pnpm 10.32.0。

## 设计与范围

采用父进程独占匿名管道 + 有界 NDJSON，而非移植旧 Unix socket 或新增公共 TCP 控制口。Node 只管理自己启动的 guardian/worker；不查找、接管或停止旧桌宠。每个 worker 有随机会话凭证和请求 ID，固定启动/状态/停止协议，不接受 renderer 的路径、脚本、实例 ID 或任意命令。外层 Fastify 原有会话鉴权、来源校验保持。

单宠开发闭环：React 的显式启动/停止 → Electron 固定无参桥接 → Fastify → PlayerRuntime → guardian → Python/Qt。只有主进程从开发者显式 `PET_PLAYER_SOURCE` / `PET_PLAYER_ASSETS` 取可信绝对路径；默认未配置、不启动。独立新 profile 位于 cross-platform-dev/player-sessions 的每会话随机子目录，不迁移、不读旧资料。Python 环境不继承模型凭证、任务租约、素材库、Python 注入变量；HOME/配置/缓存/语音与账号入口指向本会话隔离目录。

实际播放器复用审核过的 prepared source 内 `pet_helper._factory`，不改动画缓存、异步解码、拖拽或甩动物理。新进程只装配其窗口生命周期，禁用账号查询、聊天、语音、声音与上游托盘菜单。所有 Qt 对象、信号、开始/停止都在 GUI 线程；stdin 线程仅将有界消息放队列，主线程 QTimer 消费。独立 guardian 在服务崩溃后仍回收自有 worker，正常停止必须等适配器 stopped（解码线程等清理完成）及子进程退出，不把收到停止请求当作停止完成。

## 平台与证据

控制传输不依赖 Unix socket、fcntl、uid 或平台路径，标准库/Node 合成测试进入三系统 CI。现有 prepared Pet 仍仅在 darwin 使用异步 frame store，并含 Python 3.11+ 的 tomllib 依赖；不能为了首轮接通在其他平台静默回退同步解码。因此本增量实际既有播放器只开放 macOS + Python 3.11+ 的显式开发启动，Windows/Linux 返回明确 blocked；按用户最新要求，解码/窗口移植暂缓，先完成现有 macOS 功能迁移，未来移植并验收后才开放。跨平台传输可用不等于三端动画可用。

不修改既有冻结 helper 输入、不重建/签名/安装旧应用。真实桌面必须另获预览授权；本轮仅本机 Fusion/offscreen、临时 HOME、合成动画与无账号夹具。生产素材/字体不作为自动测试输入；既有字体发布约束不变。

## 失败处理

NDJSON 每帧最多 4096 字节，严格字段、会话、请求 ID、阶段枚举；stdout 仅固定协议，日志与原始错误不进入 API。未配置/不支持/解释器缺失/启动超时/协议故障/中途退出均明确状态；无无限重启。并发 start 合并，stop/close 能取消尚未完成 start；错误后只有显式下一次 start 可创建新会话。关闭服务先收播放器和诊断 worker，再退出；guardian 另有 EOF 与有界终止兜底，不杀外部进程。


## 实现复核补充

- 请求/回复仍固定字段。正常本地菜单停止或 EOF 在适配器 stopped 后发固定终止事件 `{version:1,event:"stopped"}`，不携带凭证、路径或原始错误；Node 识别此事件后仍等待自有进程退出。
- start 取消时另发 stop 请求，至多接受一次已取消 bootstrap 的已知 ID 回复，不将旧 ready 计为新成功；公开 start Promise 等待完整停止结果，内部启动任务与停止任务分开以避免互相等待。
- 必须同时确认 stopped 与进程退出。超时后的强制回收保留 error，不能当作 GUI/解码已正常清理；close 拒绝，服务以非零退出传回 Electron 壳层。
- operation 按 epoch 隔离；`await stop()` 后立刻 `start()` 必须创建新会话，取消操作的延迟 finalizer 不得复用或清除新启动。
