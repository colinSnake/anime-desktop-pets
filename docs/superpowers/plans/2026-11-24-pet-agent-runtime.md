# 桌宠统一 Agent 内核实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户要求复核后直接实施；不另行提交 Git，不启动真实桌面或调用付费模型。

**Goal:** 用 Pi 统一文字和材料工具循环，增加私有运行状态与可复用语音/直播调度基础，移除当前 DSH 产品执行链。

**Architecture:** Pi 仅负责 Agent 循环，ModelManagement 继续唯一拥有路由/凭证/网络。产品拥有权限、实例准入、终态、持久化及不同输入来源生命周期；复用既有聊天与角色资料边界。

**Tech Stack:** Electron、React、Node.js 24.x、TypeScript、SQLite、pnpm 10.32.0、Pi Agent Core 1.6.0。

**Spec:** `docs/superpowers/specs/2026-11-24-pet-agent-runtime-design.md`

## Global Constraints

- Node.js 24.x、pnpm 10.32.0，禁止 npm；精确锁定 Pi 1.6.0。
- 保护工作树已有修改。当前 main 存在用户未提交修改，按用户“复核后动手”的授权原地有限编辑，不为分支隔离丢失当前状态，不提交/推送。
- 保留模型 schema v2、Keychain、原固定 IPC、逐项在线授权、桌宠素材和非旧 Agent 专属数据。
- 不启动真实 Electron、不结束外部进程、不测试真实账号/收费服务；执行过程仅使用临时根和合成 Provider。

### Task 1: 私有 Agent 定义与运行账本

**Files:** 新建 `apps/app-service/src/agent/agent-state.ts` 与 `apps/app-service/test/agent-state.test.ts`。

**Interfaces:** `AgentStateStore(root)`；`ready(): Promise<void>`；`ensureAgent(petID): Promise<AgentDefinition>`；`begin({requestID,petID,source}): Promise<void>`；`finish(requestID,status,signal?): Promise<void>`；`close(): Promise<void>`；`status(requestID): Promise<RunRecord|undefined>`。source 为 chat/voice/live/task，终态为 completed/failed/cancelled/interrupted。账本不存正文。

- [x] 先写真实临时目录测试：持久重复 ID 拒绝、重启活动轮次 interrupted、配置隔离及 0700/0600、符号链接拒绝；运行 `pnpm exec tsx --test apps/app-service/test/agent-state.test.ts` 确认缺实现失败。
- [x] 使用 Node SQLite、PrivateDirectory、固定文件名及原子受限文件操作实现接口；同一服务单写入者，不扫私有用户目录。
- [x] 重跑测试，检查类型；回报改动路径与结果，不提交。

### Task 2: 锁定 Pi 并接入唯一循环（主执行者）

**Files:** 新建 `apps/app-service/src/agent/pi-runtime.ts`、`apps/app-service/test/pi-runtime.test.ts`；修改 task-runtime.ts、text-chat-runtime.ts、online-chat.ts、entry.ts、依赖与构建入口。

**Interfaces:** `runPiAgent({text,system,tools?,attachments?,complete,signal,acceptReply?,afterTools?}): Promise<string>`，`complete` 以内部 ModelInput/ModelReply 为边界，轮数、工具和上下文预算在内核固定限制；`createPiTextRuntime` 满足现有 TextChatRuntime。task-runtime 仅负责创建授权材料工具，不再有第二个模型循环或 verify_task_tools 预请求。

- [x] 先写合成 provider 回归：一次普通回复、工具→回复、取消/空/length/refused/异常、未知工具/循环预算，执行测试并确认缺实现失败。
- [x] `pnpm --filter @pet/app-service add --save-exact @earendil-works/pi-agent-core@1.6.0 @earendil-works/pi-ai@1.6.0`，只导入核心和类型/事件流，无内置 provider。
- [x] 在自定义 streamFn 内转换已校验 transcript 与回包；取消贯穿 signal，工具顺序执行，未知工具与参数 fail closed，异常恢复原产品错误类型。
- [x] entry 接新内核；TextChatTurns 接账本、保持实例槽与去重/关闭语义；撤销 DSH 构建引导与无用运行探测。重跑新测试和 online-chat-dispatch/agent-task 相关回归。

### Task 3: 显式本机命令与自然语言分流

**Files:** packages/contracts/src/local-chat.ts、packages/contracts/test/local-chat.test.ts、apps/workspace-ui/src/chat-session.ts、apps/workspace-ui/test/chat-session.test.ts 及直接相关测试。

- [x] 将“你是谁？”新的预期先写入测试：有路由时走普通模型，无路由显示明确选模状态；“查看本机身份”仍为固定本机命令。
- [x] 删除“你是谁”正则截获与本机快捷类型，不动其它用户草稿/附件/授权样式改动。
- [x] 跑 contracts 和 chat-session 测试并记录结果。

### Task 4: 语音与直播通道的安全调度基础

**Files:** 新建 apps/app-service/src/agent/channel-coordinator.ts 与 test/agent-channel-coordinator.test.ts。

**Interfaces:** `AgentChannelCoordinator.run({petID,source,eventID,text,occurredAt}, execute, signal?)`，source=chat/voice/live；仅直播要求 `occurredAt`；live 忙碌丢弃，手动输入取消同实例直播且等待执行清理，再执行；停止/输出通过轮次代次和 signal 门禁。execute 只得到当前文本/source/signal/isCurrent；此模块不读取角色或聊天仓库。

- [x] 先测试语音抢占直播、直播不能抢手动、不同实例隔离、重复/过期/超长直播输入、有界去重、取消后迟到输出被门禁拒绝。
- [x] 最小实现调度器；无平台 SDK、麦克风或 TTS 假接线。明确将来 UI/平台接入需要显式授权与单独验收。
- [x] 合成测试通过，文档标注“通道基础已实现，真实语音/直播未接入”。

### Task 5: 退役、全量回归与证据

- [x] 搜索当前构建/服务/脚本对 DSH 引用，移除废弃 worker、回环工具与专属验收脚本；涉及历史验证文档保留历史事实但新增清晰退役说明。
- [x] 复核依赖图中无 DSH；`pnpm install --frozen-lockfile`、`pnpm run check:cross-platform` 与 `git diff --check`，如失败按根因修复并重跑。
- [x] 同步 AGENTS.md、README.md、README.zh.md、docs/桌宠智能体方案.md、docs/本机业务数据与聊天历史.md、docs/聊天与智能体验证.md、docs/实际验证记录.md；记录未执行真实设备/平台/收费模型。
- [x] 独立复核整个变更的权限、取消、循环预算、构建依赖及文档诚实性，修复实际问题；不删除未知用户数据，不提交。

## 实施前自审（2026-11-24）

- [x] 对齐语音/直播目标：支持文字决策与有界调度，不冒充音频或平台 SDK。
- [x] 不将“完全允许”扩展到目录/Shell/后台记忆写入；不默认授权私人资料进入直播。
- [x] 版本发布包接口已核对；已有完成会话不必为更换内核重建。
- [x] 跨进程回环可移除但宿主取消超时和清理门禁必须保留；无另一套凭证/服务商通路。
- [x] 删除私有用户数据不是本轮成功条件；优先移除不再运行的旧代码与依赖，无需制造数据损失。
- [x] 用户已批准“复核后动手”，不再为执行方式重复询问。

## 实施后验收

- 最终 `pnpm run check:cross-platform` 退出 0：工作区 3、工具链 26、TypeScript 944、Python 桥 13、构建冒烟 25，均无失败或跳过。类型检查和打包通过。
- 独立复核后的定向回归覆盖授权撤回、模型轮换、取消排空和混合 Responses 材料。编译服务冒烟验证临时业务根和合成本机 HTTP 模型，仅一次出站。详见[实际验证记录](../../实际验证记录.md)。
- 后续接线不属于本轮勾选范围：真实语音完整链路、平台账号/连接、长直播去重与配额隔离，以及终态后的播报代次管理。
