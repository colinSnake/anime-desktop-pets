# 多模态聊天附件实施计划

> **For agentic workers:** Execute after `2026-11-23-model-editor-capabilities.md`; use `superpowers:test-driven-development` for each behavior. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户显式选取的有界附件作为当前聊天回合输入，完成 Responses 编码，并确保附件不进入草稿持久化、SQLite 历史或后续隐式重放。

**Architecture:** renderer 通过文件选择控件取得 `File` 字节并通过现有固定聊天 DTO 传输，不传路径。合同、Electron IPC、Fastify 服务和模型客户端逐层验证同一组大小/类型边界；只有服务端重新验签且已保存路由确实声明对应模态时才能出站。纯文本仍沿用现有文本历史，含附件回合不可重放。

**Tech Stack:** React、TypeScript contracts、Electron IPC/preload、Fastify、Node `Buffer`/`TextDecoder`、Responses adapter、SQLite history。

**Spec:** `docs/superpowers/specs/2026-11-23-pet-agent-model-core-parity-design.md`

## Global Constraints

- 每回合最多 5 个文件；单文件最多 5 MiB；合计最多 15 MiB。
- 文本附件最多 20,000 字符；问题和文本附件合计最多 60,000 字符。
- 只接受 PNG/JPEG/WebP/PDF 和合同明确列出的纯文本/源码扩展名；MIME、扩展名与签名必须一致。
- renderer 不传路径；附件正文不落 SQLite、会话恢复草稿、日志或崩溃报告。
- 非 Responses 路由或未声明所需模态时，在首次 Provider 请求前拒绝。
- 附件回合和结果未知请求不得自动重放或切换模型。

---

### Task 1: 固定附件 DTO 与逐层合同

**Files:**
- Create: `packages/contracts/src/chat-attachments.ts`
- Modify: `packages/contracts/src/online-chat.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/chat-attachments.test.ts`
- Test: `apps/app-service/test/online-chat-dispatch.test.ts`

**Interfaces:**
- `ChatAttachment = { name: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | 'text/plain'; data: string }`, where `data` is canonical base64 without a data-URL prefix.
- `OnlineChatInput.attachments?: ChatAttachment[]` is accepted only on the current send; `ChatExchange` remains text-only.
- Export `validateChatAttachments(value, text)` returning a discriminated bounded result with validated bytes and text, or a fixed contract error.

- [ ] **Step 1: Add tests** for exact count/byte/character boundaries, canonical base64, UTF-8 fatal decode, safe filenames, extension/MIME agreement, PNG/JPEG/WebP/PDF signatures, forged MIME, duplicate/invalid fields, and text total.
- [ ] **Step 2: Run `pnpm exec tsx --test packages/contracts/test/chat-attachments.test.ts`** and confirm the new module is missing.
- [ ] **Step 3: Implement the pure shared validator** with no path reads, no filesystem access, and no logging.
- [ ] **Step 4: Add input-contract tests** proving text-only legacy requests still pass and attachments exceeding the fixed request budget fail.

### Task 2: Encode only the admitted current turn

**Files:**
- Modify: `apps/app-service/src/models/types.ts`
- Modify: `apps/app-service/src/models/common.ts`
- Modify: `apps/app-service/src/models/responses.ts`
- Modify: `apps/app-service/src/models/client.ts`
- Modify: `apps/app-service/src/online-chat.ts`
- Modify: `apps/app-service/src/server.ts`
- Test: `apps/app-service/test/model-protocols.test.ts`
- Test: `apps/app-service/test/online-chat-dispatch.test.ts`

**Interfaces:**
- A validated internal user message carries `text` and optional decoded `attachments`; public model history types never carry prior attachment bytes.
- Responses maps image bytes to `input_image` and PDF bytes to `input_file` on the current user item; text attachments become bounded `input_text` parts.
- Set the Fastify body limit to the derived maximum encoded request size; keep the 64 KiB effective limit on all non-chat routes through their existing route contracts.

- [ ] **Step 1: Add failing adapter tests** for each supported current-turn attachment form, text ordering, no change to the caller input object, and refusal of attachments on all other protocols.
- [ ] **Step 2: Add failing dispatch tests** proving route modality mismatch, malformed bytes, oversized encoded Provider JSON, and cancelled requests make zero Provider calls.
- [ ] **Step 3: Implement server-side validation before opening credentials; add a dedicated request-size bound for chat and preserve all other route bounds.**
- [ ] **Step 4: Encode Responses-only attachment parts and enforce an encoded-body cap before `fetch`.**
- [ ] **Step 5: Run the adapter and dispatch tests; assert SQLite receives only user text and verified assistant text.**

### Task 3: Select and retain files only for the active renderer turn

**Files:**
- Modify: `packages/contracts/src/online-chat.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/chat-ipc.ts`
- Modify: `apps/desktop/src/chat-transport.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/workspace-ui/src/ChatComposer.tsx`
- Modify: `apps/workspace-ui/src/chat-session.ts`
- Modify: `apps/workspace-ui/src/chat.css`
- Test: `apps/desktop/test/online-chat-ipc.test.ts`
- Test: `apps/desktop/test/chat-transport.test.ts`
- Test: `apps/workspace-ui/test/chat-session.test.ts`
- Test: `apps/workspace-ui/test/chat-page.test.ts`

- [ ] **Step 1: Add failing UI/controller tests** for explicit file selection, remove-before-send, model capability mismatch, attachment clearing on successful send/cancel/character switch, and no attachment restoration after page reload.
- [ ] **Step 2: Add failing bridge tests** confirming fixed chat IPC rejects path fields, wrong instance context, oversize payloads, and unknown fields.
- [ ] **Step 3: Add a native multiple-file input to the existing composer**; read selected `File.arrayBuffer()` values locally and pass only `{name, mediaType, data}` through the existing chat send bridge. Do not persist bytes in `ChatDraft`.
- [ ] **Step 4: Show bounded filenames/types/sizes and explicit remove controls; preserve the current composer on narrow viewports without introducing another app tab.**
- [ ] **Step 5: Run focused contract, service, desktop, and UI tests and verify no history or replay DTO accepts attachment fields.**

**Validation:** `pnpm exec tsx --test packages/contracts/test/chat-attachments.test.ts apps/app-service/test/model-protocols.test.ts apps/app-service/test/online-chat-dispatch.test.ts apps/app-service/test/chat-history.test.ts apps/desktop/test/online-chat-ipc.test.ts apps/desktop/test/chat-transport.test.ts apps/workspace-ui/test/chat-session.test.ts apps/workspace-ui/test/chat-page.test.ts`; `pnpm run typecheck`.

**Commit:** Omitted; the user has not requested a commit.
