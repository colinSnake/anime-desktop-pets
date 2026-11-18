# macOS 外部客户端只读观察实施计划

按 [macOS 功能迁移清单](../../macOS功能迁移清单.md) H02／H03 和[退役清单](../../macOS旧宿主退役清单.md)继续迁移。与旧宿主的自动联动分开：只在用户从 Electron 原生状态栏开启后，按旧宿主固定的 `com.openai.codex` bundle ID 查看当前登录会话是否检测到未退出的应用。检测到进程不表示窗口已准备好、任务在执行或服务可用。开关仅存于本次应用会话，允许关窗后从状态栏停止观察。

- [x] 用 `apps/desktop/test/codex-observation.test.ts` 先测默认关闭、只在开启时读取、串行轮询、失败清除旧状态、停用／重开与退出后的迟到结果。用假时钟和可控 Promise，不访问系统运行列表。测试固定可执行文件、空参数、有限时间和输出、只接受约定结果。
- [x] 新增独立的 macOS 桥 `apps/desktop/native/codex-presence.swift` 及 `apps/desktop/src/codex-presence.ts`。只用 AppKit 精确 bundle ID 查询并返回固定枚举，不返回 PID、路径或诊断内容。禁止自定义目标，无 renderer／服务 API；不读取任务、账号或窗口，不启动、激活或停止 Codex。超时只终止本应用启动的探针。
- [x] `codex-observation.ts` 注入读取／定时 port。即时读取后在结果返回 10 秒后再读，不并发。关闭取消后续计划、忽略迟到结果；退出销毁状态栏并回收当前有界探针。通过 `workspace-tray.ts` 显示观察开关与状态，不改变九页布局和现有自有桌宠菜单语义。
- [x] `scripts/build-cross-platform.mjs` 将新助手仅构建到 macOS Electron 暂存产物，失败保留两份旧输出；冒烟只走助手拒绝额外参数的分支，不执行真实查询。运行定向回归、`pnpm run check:cross-platform`、可信 Fusion/offscreen Qt、项目和 diff 检查。
- [x] 同步双语 README、开发文档、迁移／退役清单、路线图与验证。真实状态栏／系统检测、外部启动、启动视频、窗口同步及任务联动仍待独立验收；不读取旧用户资料、申请系统权限、修改冻结 helper、删除旧宿主或提交／推送。
