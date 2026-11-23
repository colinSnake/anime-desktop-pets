# 桌宠 Agent 任务核心实施计划

**2026-11-23 落地说明：** 实际采用 `runAgentTask` 函数和固定服务路由，不启动通用 worker，不存附件、原始任务指令或产物文件；应用边界不替代系统沙箱。下方为原实施步骤，具体复测结论见[实际验证记录](../../实际验证记录.md)。

> **For agentic workers:** Execute after `2026-11-23-multimodal-chat-attachments.md`; use `superpowers:test-driven-development` for each behavior. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每只桌宠以其 `petID` 成为可由用户显式发起、观察、取消和审阅结果的独立 Agent，同时保持只读默认和逐项授权。

**Architecture:** 新增与普通聊天分离的固定 Agent Task 合同、Electron bridge 和 app-service 执行器。每任务只拿到用户选定的有界附件副本，工具面仅提供任务附件的列表、读取和搜索，不开放文件系统路径、任意命令、网络、MCP 或子 Agent。任务状态按 petID 持久化；进程重启时将活动任务标为 `outcome-unknown`，绝不自动重放。写回授权先保持关闭，直到系统级沙箱在目标平台经独立证明。

**Tech Stack:** TypeScript、Fastify、Electron fixed IPC/preload、Node SQLite、React、现有模型 route/provider 管理。

**Spec:** `docs/superpowers/specs/2026-11-23-pet-agent-model-core-parity-design.md`

## Global Constraints

- 每桌宠最多 1 个活动任务；全局最多 3 个活动任务。
- 任务创建、继续、取消、应用均由用户显式操作；不在启动时自动继续。
- 任务绑定已登记 `petID`、taskID、attemptID 和已保存模型路由指纹/修订。
- 工作范围仅限本任务通过系统选择器选择的附件；renderer 不获得绝对路径。
- 任务内工具只能读当前附件；结果为待审纯文本，首阶段不生成结构化差异、不写入工作区。
- 任务记录只保存必要标识、有限进度和最终文本，不保存原始任务正文、附件字节、API Key、未授权文件或隐藏思维链。
- 不碰旧 DSH Runtime，不开放 shell、Skills、MCP、子 Agent、浏览器控制或后台运行。

---

### Task 1: 定义任务状态机与严格合同

**Files:**
- Create: `packages/contracts/src/agent-tasks.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/agent-tasks.test.ts`

**Interfaces:**
- `AgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'`.
- `AgentTaskCreate = { taskID: string; petID: string; route: ChatRoute; prompt: string; files: ChatAttachment[]; writeConsent?: never }`.
- `AgentTaskSnapshot = { taskID: string; petID: string; attemptID: string; status: AgentTaskStatus; phase: 'admitting' | 'reading' | 'thinking' | 'review'; progress: number; result?: string; error?: AgentTaskError }`.
- `AgentTaskBridge` exposes `create`, `list({petID})`, `read({petID, taskID})`, and `cancel({petID, taskID})`; no generic invoke method.

- [ ] **Step 1: Add failing contract tests** for valid IDs/routes/statuses, unknown-field rejection, cross-pet rejection, result/error limits, and forbidden write-consent fields.
- [ ] **Step 2: Run `pnpm exec tsx --test packages/contracts/test/agent-tasks.test.ts`** and confirm the contract module is missing.
- [ ] **Step 3: Implement exact DTO validators and fixed error codes**; reuse the attachment validator from the previous plan without widening its limits.
- [ ] **Step 4: Run the contract test and `pnpm run typecheck`.**

### Task 2: Persist task lifecycle and recover uncertain attempts

**Files:**
- Create: `apps/app-service/src/agent/task-store.ts`
- Modify: `apps/app-service/src/entry.ts`
- Modify: `apps/app-service/src/server.ts`
- Test: `apps/app-service/test/agent-task-store.test.ts`
- Test: `apps/app-service/test/server.test.ts`

**Interfaces:**
- `AgentTaskStore.create(input)`, `list(petID)`, `read(petID, taskID)`, `transition(petID, taskID, attemptID, expectedRevision, patch)`, `recoverActive()`, and `close()`.
- Persistent rows contain only bounded prompt/result/progress/event metadata; attachment bytes remain on the active task object in memory.
- Every read/mutation checks the current `PetWorkspace.withRegisteredInstance(petID, ...)` boundary.

- [ ] **Step 1: Add temp-SQLite tests** for pet isolation, single activity per pet, revision conflict, bounded event/result storage, deletion/retired pet denial, restart recovery to `outcome-unknown`, and no attachment-byte persistence.
- [ ] **Step 2: Run `pnpm exec tsx --test apps/app-service/test/agent-task-store.test.ts`** and verify it fails because the store does not exist.
- [ ] **Step 3: Implement a separate private task database/store** with strict schema validation and atomic state transitions; do not alter `chats.sqlite` history schema.
- [ ] **Step 4: Wire store creation/close into the app-service owner and add fixed service routes** after contract validation and pet registration checks.
- [ ] **Step 5: Run the store and server tests; confirm restarting never starts a Provider call.**

### Task 3: Execute bounded read-only agent turns

**Files:**
- Create: `apps/app-service/src/agent/task-runtime.ts`
- Modify: `apps/app-service/src/models/management.ts`
- Modify: `apps/app-service/src/server.ts`
- Test: `apps/app-service/test/agent-task-runtime.test.ts`
- Test: `apps/app-service/test/model-client.test.ts`

**Interfaces:**
- `AgentTaskRunner.run(create: AgentTaskCreate, signal: AbortSignal, onProgress: (phase: AgentTaskSnapshot['phase'], progress: number) => void): Promise<{ result: string; artifacts: AgentTaskArtifact[] }>`.
- Provider dispatch is injected as a typed function over the already-validated saved route; it resolves the Key inside `ModelManagement` and never sends the Key or credential reference to the task runner.
- Tool schemas are fixed to `list_task_files`, `read_task_file`, and `search_task_files`; each argument must identify a file in the current task’s in-memory selection. At most five tool round trips and eight calls total, with a 12-message cap and a 3,300 UTF-16-unit transcript budget for intermediate tool results and assistant text.

- [ ] **Step 1: Add tests** for one validated Provider route, stale route/credential revision rejection before dispatch, allowed attachment reads/search, path-like/unknown tool rejection, tool-round and byte limits, cancellation, no Key in worker inputs/results, and no automatic replay after unknown outcomes.
- [ ] **Step 2: Run `pnpm exec tsx --test apps/app-service/test/agent-task-runtime.test.ts`** and confirm the runner is missing.
- [ ] **Step 3: Implement the fixed tool loop over the existing protocol adapter tool-call contract.** Do not execute model-returned code, commands, paths, URLs, or dynamic tool names.
- [ ] **Step 4: Bind every event/result to petID/taskID/attemptID and the original route fingerprint; persist only bounded metadata and the final reviewed result.**
- [ ] **Step 5: Run runtime tests with a synthetic provider callback; make zero real network/provider calls.**

### Task 4: Expose fixed task operations over Electron and the chat surface

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/agent-task-ipc.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/service-process.ts`
- Modify: `apps/workspace-ui/src/ChatPage.tsx`
- Modify: `apps/workspace-ui/src/ChatComposer.tsx`
- Create: `apps/workspace-ui/src/AgentTaskPanel.tsx`
- Modify: `apps/workspace-ui/src/chat.css`
- Test: `apps/desktop/test/agent-task-ipc.test.ts`
- Test: `apps/workspace-ui/test/agent-task-panel.test.ts`
- Test: `apps/workspace-ui/test/chat-page.test.ts`

- [ ] **Step 1: Add failing bridge/controller tests** for trusted visible-frame admission, wrong-pet/task rejection, duplicate creation, cancel propagation, active status refresh, read-only result review, and restart `outcome-unknown` display.
- [ ] **Step 2: Add task creation to the existing selected-pet chat surface**; require an explicit task prompt, model route, and file selection before start. Keep daily chat DTO/history untouched.
- [ ] **Step 3: Implement fixed task IPC methods only (`create/list/read/cancel`) and guard them with the existing trusted frame, visibility, instance registration, size and operation-ID checks.** Never expose generic filesystem or process APIs.
- [ ] **Step 4: Render task phase/progress, cancel, terminal state, and plain-text result in a review panel; structured diffs remain deferred.** Show no apply button while platform write isolation is unavailable.
- [ ] **Step 5: Run desktop/UI tests, `pnpm run typecheck`, and the repository cross-platform gate.**

### Task 5: Document capability boundary and acceptance evidence

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/桌宠智能体方案.md`
- Modify: `docs/实际验证记录.md`

- [ ] **Step 1: Document task creation, attachment limits, per-pet isolation, restart recovery, and the fact that writes/shell/Skills/MCP are unavailable.**
- [ ] **Step 2: Record only this run’s test commands and exact pass/fail/skip counts; keep real OS clipboard, Electron preview, provider, Keychain and platform sandbox as unexecuted when not authorized.**
- [ ] **Step 3: Run `git diff --check`, inspect the full diff for secret/path leakage, and verify every plan/spec acceptance item against tests or an explicit unverified boundary.**

**Validation:** `pnpm run typecheck`; `pnpm run test:cross-platform`; `pnpm run check:cross-platform`; focused task contracts/service/IPC/UI tests. Real desktop, OS sandbox, provider, Keychain and native clipboard acceptance are explicitly separate.

**Commit:** Omitted; the user has not requested a commit.
