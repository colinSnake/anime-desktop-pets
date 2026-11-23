# 聊天输入框与桌宠 Agent 权限实施计划

> 日期：2026-11-23
> 目标：将聊天输入区按 Ape Agent Harness 的核心交互重构，接入“请求批准／完全允许”权限选择，并修正模型管理后的默认模型选择；保持当前 Electron + React + Lexical 架构及已有安全边界。

## 背景与边界

当前聊天输入区已有 Lexical 编辑器、草稿恢复、粘贴、中文输入法和字数限制，但输入区结构与 Ape Agent Harness 的 composer 不一致。当前普通在线聊天是纯文字链路，真正可执行“桌宠 Agent”任务的入口是 `AgentTaskPanel` 和 `agent-tasks` 服务；因此权限选择不能只作为一个没有后端含义的 UI 参数，必须进入 Agent Task 请求合同并在服务端校验、透传、展示。

本次只实现当前仓库已经支持的 Agent Task 能力：读取用户明确选择的文本材料和搜索当前任务材料。不会扩大为 Shell、任意路径、写文件或外部工具权限，也不会把“完全允许”宣传为系统级权限。权限确认只在当前桌宠、当前模型和当前任务范围内有效，不持久化；切换桌宠、模型或重新编辑任务时撤销。

不回滚当前工作区已有的模型管理、附件、HMR 或桌宠 Agent 改动；不启动真实 Electron／桌宠，不做真实服务计费或账号验收。

## 文件范围与职责

### 合同与服务

- `packages/contracts/src/agent-tasks.ts`
  - 新增严格的 `AgentTaskExecutionPermission` 类型，至少包含 `mode: 'ask' | 'full'`。
  - 将权限字段加入 `AgentTaskCreate`，保持字段可序列化、可校验、可向后兼容地处理缺失值（缺失按 `ask`）。
  - 保留当前任务方法、错误码和大小限制；禁止把权限字段扩展成任意命令或路径配置。
- `packages/contracts/src/index.ts`
  - 导出新增权限合同。
- `packages/contracts/test/agent-tasks.test.ts`
  - 先写权限枚举、默认模式、非法值拒绝和创建请求合同测试。
- `apps/app-service/src/agent/task-routes.ts`
  - 从请求体读取并校验权限模式，缺失时归一为 `ask`。
  - 将归一后的权限传给运行时，拒绝未知模式或畸形结构。
- `apps/app-service/src/agent/task-runtime.ts`
  - 在任务快照／运行上下文中保留权限模式。
  - `ask` 和 `full` 只影响任务内部的审批策略入口；不得越过当前固定工具白名单。
  - 完全模式需要已经由 UI 明确确认的请求值；服务端仍按当前任务可用工具边界执行。
- `apps/app-service/test/agent-task-service.test.ts`
  - 覆盖权限透传、缺省 `ask`、非法模式、任务快照隔离和任务创建失败路径。

### UI 权限控件与输入区

- `apps/workspace-ui/src/AgentTaskPanel.tsx`
  - 加入权限选择器：默认“请求批准”，可切换“完全允许”。
  - 切换到“完全允许”时打开独立确认对话框；确认后才允许提交 `full`。
  - 桌宠、模型、任务编辑内容变化时撤销当前 `full` 确认。
  - 只将确认后的权限模式提交给 Agent Task bridge，不在普通文本聊天请求上伪造参数。
- `apps/workspace-ui/src/ChatComposer.tsx`
  - 重构为 Ape 风格圆角卡片：编辑区与底部操作栏分离。
  - 左侧保留附件／添加内容入口和快捷键提示；右侧放权限选择、模型选择、发送／停止。
  - 保持现有 controller API、草稿保存、发送、停止和禁用状态。
- `apps/workspace-ui/src/ChatDraftEditor.tsx`
  - 保留 Lexical 实现，整理为 composer 所需的编辑器容器和无障碍属性。
  - 保留粘贴、撤销／重做、中文输入法、光标／选区恢复、字数限制。
  - 输入框 focus 不使用 ring，只通过边框或背景状态反馈。
- `apps/workspace-ui/src/chat.css`
  - 按 Ape Harness 的层级、圆角、间距和操作栏布局补齐样式。
  - 新增权限菜单、完全允许确认对话框、编辑区、附件提示、停止态和窄宽度布局样式。
  - `:focus`／`:focus-visible` 不绘制外圈 ring；保留键盘可感知的边框颜色或阴影内反馈。
- `apps/workspace-ui/test/agent-task-panel.test.ts`
  - 覆盖默认 ask、full 需要确认、确认后提交、切换上下文撤销、权限字段透传。
- `apps/workspace-ui/test/chat-page.test.ts`
  - 覆盖 composer 结构、发送／停止、模型选择和默认模型显示。
- `apps/workspace-ui/test/focus-styles.test.ts`
  - 补充 composer、textarea/contentEditable、对话框控件无外圈 ring 断言。

### 模型默认选择

- `apps/app-service/src/models/chat-models.ts`
  - 明确模型管理配置顺序的稳定排序和“第一个服务商的第一个可用模型”候选计算。
  - 保留已设置全局默认模型的优先级。
- `apps/workspace-ui/src/model-state.ts`
  - 统一默认模型归一化逻辑：全局默认 > 当前有效手动选择 > 配置顺序首个可用模型。
  - 模型刷新时不覆盖用户手动选择；只有当前路由失效或被删除时才回退。
- `apps/workspace-ui/src/ChatPage.tsx`
  - 首次加载、模型管理变化和会话切换时使用稳定的默认模型。
- `apps/workspace-ui/src/chat-session.ts`
  - 保持显式选择优先，并在路由失效时采用新的首个可用候选。
- `apps/workspace-ui/test/chat-session.test.ts`
  - 覆盖全局默认、首个服务商首个模型、手动选择保留、失效路由回退。
- `apps/workspace-ui/test/model-workspace.test.ts`
  - 覆盖模型管理更新后聊天选择器显示与默认模型同步。

### 文档与验证记录

- `README.md`
- `README.zh.md`
- `docs/桌宠智能体方案.md`
- `docs/ui-desgin.md`
- `docs/实际验证记录.md`
  - 记录 composer、权限范围、默认模型规则和本轮测试证据；明确真实桌面／真实服务未验收边界。

## 实施步骤（TDD）

1. **建立合同失败测试**
   - 先在合同测试和 Agent Task 服务测试中加入权限模式、缺省和非法输入场景。
   - 单独运行 `pnpm exec vitest run packages/contracts/test/agent-tasks.test.ts apps/app-service/test/agent-task-service.test.ts`，确认因实现缺失而失败，失败原因必须是预期的权限合同／透传缺失，而不是环境错误。
2. **实现合同与服务端最小闭环**
   - 修改 contracts、route、runtime 和相关导出。
   - 重跑上述测试，确保权限不越过固定工具白名单且请求能被读取。
3. **建立 UI 失败测试**
   - 在 Agent Task Panel、Chat Page、chat session 和 focus styles 测试中先写选择器、确认弹窗、提交字段、默认模型和无 ring 断言。
   - 单独运行相关 workspace-ui 测试确认失败原因符合预期。
4. **实现权限 UI**
   - 按 Ape Harness 的 `PermissionPicker`／`FullExecutionDialog` 交互实现，但不引入 Mantine。
   - 将确认状态限定为当前桌宠、当前模型、当前任务编辑会话；普通聊天不发送伪权限字段。
5. **实现 composer 结构与样式**
   - 在不破坏 Lexical 编辑器能力的前提下整理组件层级，使用现有 `PetNookIcon` 和 CSS 变量。
   - 完成附件入口、快捷键提示、权限／模型／发送操作栏、停止态和无 ring focus 状态。
6. **实现默认模型策略**
   - 增加服务端稳定候选和前端归一化，验证全局默认、手动选择与失效回退的优先顺序。
7. **重构与完整测试**
   - 先运行相关包测试，再运行 `pnpm run check:cross-platform` 和 `git diff --check`。
   - 如存在失败，按失败根因修复，不用放宽断言绕过问题。
8. **同步文档与验证记录**
   - 更新根 README、中英文设计说明和实际验证记录；只记录本轮真实执行结果，标注未执行或未验收项。

## 验收标准

- Agent Task 请求缺省权限为 `ask`，未知模式被拒绝。
- UI 默认显示“请求批准”；选择“完全允许”必须经过确认，取消确认不提交 `full`。
- 切换桌宠、模型或重新编辑任务会撤销完全允许确认。
- 服务端仍只执行当前固定任务工具集合，不暴露 Shell、任意路径、写文件或外部工具。
- composer 视觉和布局接近 Ape Harness：编辑区／操作栏分层，权限和模型位于右侧，发送／停止状态明确。
- Lexical 原有编辑能力不回归；输入控件无外圈 focus ring。
- 已有全局默认模型优先；无全局默认时选择配置顺序第一个服务商的第一个可用模型；用户手动选择不被刷新覆盖；失效时才回退。
- 相关自动化测试、跨平台检查和 diff 检查均有本轮实际结果。
