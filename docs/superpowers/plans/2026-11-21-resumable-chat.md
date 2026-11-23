# 桌宠历史续聊实施计划

> **执行约束：** 按任务逐项自测；若未授权提交或发布，不提交、不推送。

**目标：** 从历史打开同一会话并可在显式切模后续聊。

**架构：** SQLite 保存会话和完成问答；固定详情桥仅呈现摘要和正文。在线发送绑定实例及会话，回放由服务选择，渲染器继续复用小话间。

**技术栈：** TypeScript、Electron IPC、Fastify、Node SQLite、React。

**设计：** `docs/superpowers/specs/2026-11-21-resumable-chat-design.md`

## 全局约束

Node.js 24.x、pnpm 10.32.0，不新增依赖。不访问用户聊天库、Keychain、真实厂商或运行中的桌面。保持现有工作区修改。

## 任务

- [x] 在 `apps/app-service/test/chat-history.test.ts` 先验证旧表不迁入、稳定编号、同会话排序/重开、按实例拒绝读取、受保护问答不回放；实现 `packages/contracts/src/chat-history.ts` 及 `apps/app-service/src/chat-history.ts`。
- [x] 在 `apps/app-service/test/online-chat-dispatch.test.ts` 验证合成跨厂商问答、未授权/已清理/错实例拒绝、缺失数据库的终态；实现 `apps/app-service/src/online-chat.ts` 及 `packages/contracts/src/online-chat.ts`；固定 `detail` 接进 desktop transport、IPC、preload 并扩充边界测试。
- [x] 在 `apps/workspace-ui/test/chat-session.test.ts` 验证草稿、恢复后切模、同一会话发送、进行中切换限制；改 `chat-session.ts`、`ChatHistory*`、`ChatPage.tsx` 和 `ChatComposer.tsx`。保留列表箭头和整行点击。
- [x] 更新主题文档、双语 README 与实测记录；运行 `pnpm run check:cross-platform`，用隔离模拟浏览器验证流程并截图（若环境可用）。

## 审查后的回归修复

- [x] SQLite 与契约：先复现边界会话收到新回复后的重复条目；改为用该页最后一条会话的完成问答 ID 定位固定排序边界，验证跨实例与清空后不能引用旧游标。
- [x] Chat controller、服务与 IPC：先复现切模重发同一未确认提问，保留逻辑轮次；服务先按实例／会话／问题核对完成记录，恢复结果不读 Key、不派发模型、不新增问答；无记录时才向明确选定的模型发送。
- [x] Chat controller 与聊天菜单：用合成草稿验证清空后仍有恢复入口、选区与实例隔离；只恢复窗口内草稿，不复用已删除会话。
- [x] 复跑全套检查和合成浏览器；更新使用文档、UI 规范、双语 README 和验证记录。最近六个问答的回看上限不变。

## 补齐会话内回看

- [x] 先用临时库、回环 HTTP 和固定 IPC 写回归：首屏仍取最近六轮，旧页用会话内完成问答 ID 作固定游标，拒绝过期、跨会话及跨桌宠游标；不改变库结构和模型回放。
- [x] 在详情底部复用现有控制样式，加入「更早消息／较新消息」。只装载当前页正文，点击才读取；回看旧页不替换用于续聊的最新预览，返回列表仍恢复原焦点。
- [x] 验证分页与续聊、更新专题文档和双语 README；仅用临时库与模拟模型／浏览器，不访问用户库或真实服务。
