# 聊天工作区第一段迁移计划

**目标：** 用户已确认聊天按 macOS 设计同步，输入交互参考 deepseek-harness。本段交付可编辑聊天页与有界内存会话；真实模型配置/安全存储/请求桥接是下一段，不提供假回复。

**边界：** 当前工作区增量实现；pnpm 10.32.0；不新增依赖，不碰冻结 helper/生成源码/旧资料/多厂商设计，不提交推送，不启动真实 Electron/Qt。仅通过测试注入合成回复适配器，生产不挂载该适配器。

**对照：** macOS CharacterChatWelcomeView / CharacterChatComposer / CharacterChatMessageView / CharacterWorkspaceChat / CharacterChatSession；保留1200字输入、12条历史与6000字预算（最新两条完整消息例外），模型选择仅影响后续请求。

**参考：** [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/ca33fd6843b205e279c7ccb6cb73a472c78f5760)，commit `ca33fd6843b205e279c7ccb6cb73a472c78f5760`，`packages/client/ui-conversation/src/client/input/editor/keymap.ts`、`submission-policy.ts`、`ComposerContentEditable.tsx` 与 `skeleton/InputBar.tsx`；仅参考交互设计，独立实现，不复制第三方源代码。IME保护包括 composing、229与compositionend短窗口；本产品不提供加速投递/任务队列、附件、路径或斜杠工具。

## 文件职责

- `apps/workspace-ui/src/chat-session.ts`：字符预算、内存会话、角色隔离、取消/重试和迟到响应保护；无网络和持久化。
- `apps/workspace-ui/src/chat-input.ts`：输入法及快捷键纯策略。
- `apps/workspace-ui/src/ChatComposer.tsx`：原生textarea、2至7行自适应、模型选择、发送/停止与焦点。
- `apps/workspace-ui/src/ChatPage.tsx` 与 `chat.css`：macOS空态标志、左右气泡、固定时间、滚动区、底部输入和清空确认。
- `apps/workspace-ui/src/App.tsx`：挂接页面及跨页存活的controller；只使用新工作区已有实例元数据，不读取旧身份。
- `apps/workspace-ui/test/chat*.test.ts`：真实controller与SSR、输入策略测试；测试适配器不进入默认产品。

## 执行顺序

- [x] 先写输入策略/预算/会话隔离/取消重试测试并确认RED，再最小实现。
- [x] 先写macOS布局和无配置禁用测试确认RED，再实现React页面及接线。
- [x] 合成无头浏览器验证键盘/IME、textarea高度、滚动、清空确认、切页草稿和窄窗；不使用真实模型或桌面。
- [x] 执行 `pnpm run check:cross-platform`、可信 Fusion/offscreen `scripts/test-player-qt.py`、`python3 scripts/check-project.py` 和 `git diff --check`。
- [x] 更新中英文README、迁移清单、开发文档、路线图和实际验证记录；第一段不是M3模型聊天完整交付。

## 实际结果

2026-11-18：新增18项回归通过；全量219项、可信 Qt/Fusion/offscreen 10项、项目规则33项及差异空白检查通过。Chrome无头合成17组检查通过。完整命令、首次失败修复和未验收边界见 `../../实际验证记录.md` 当日聊天条目。第一段不包含真实模型服务，生产发送仍禁用；未提交推送、未打开真实 Electron/Qt。
