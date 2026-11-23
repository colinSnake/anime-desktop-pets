# 模型编辑器与模型能力实施计划

> **For agentic workers:** Execute inline with `superpowers:executing-plans`; use `superpowers:test-driven-development` for each behavior. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将模型编辑器按 Ape 的 480px 弹窗结构重排，并使推理等级与 Responses 输入模态从配置保存贯通到不可变路由和 Provider 请求。

**Architecture:** 保持 schema v2、连接/模型双层默认、凭证引用和显式联网测试不变。新增字段属于每个 `ModelEntry`，由共享合同和 app-service 严格复核；路由指纹覆盖能力字段，协议编码器只发送已支持的能力。编辑 UI 移除旧折叠入口，把兼容项与连接默认放回主表单。

**Tech Stack:** TypeScript 7、React 19、Node test runner/tsx、Electron preload fixed bridge、CSS。

**Spec:** `docs/superpowers/specs/2026-11-23-pet-agent-model-core-parity-design.md`

## Global Constraints

- 保持 schema v2，旧配置缺少新增字段时继续有效。
- 输入模态首批仅允许 OpenAI Responses 的 `image` 和 `pdf`，且 `pdf` 必须同时具备 `image`。
- 未命中本地受审规则的模型使用自动推理等级且不发送推理字段。
- API Key 不回读、不进入配置/日志/错误；只通过原生密码输入和当前保存命令短暂传递。
- 保存默认不联网；连接测试仍须当前草稿显式同意。
- 不改 Ape 仓库，不新增剪贴板 API，不请求真实 Keychain/供应商。

---

### Task 1: 扩展模型合同与严格校验

**Files:**
- Modify: `packages/contracts/src/models.ts`
- Modify: `apps/app-service/src/models/types.ts`
- Modify: `apps/app-service/src/models/config.ts`
- Test: `apps/app-service/test/model-config.test.ts`

**Interfaces:**
- Add `ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max` and `InputModality = 'image' | 'pdf'`.
- Add optional `ModelEntry.reasoningEffort?: ReasoningEffort` and `ModelEntry.inputModalities?: InputModality[]`.
- Add the resolved model’s optional reasoning effort and immutable modality list to `ModelRoute`.

- [ ] **Step 1: Write regression tests** for legacy schema-v2 acceptance, valid Responses image/PDF capability, duplicate modality rejection, PDF-without-image rejection, invalid reasoning values, and rejecting non-Responses modalities.
- [ ] **Step 2: Run the focused test and confirm the new cases fail** while existing legacy-config cases pass.
- [ ] **Step 3: Add the exact optional fields to the shared types and strict allowed-key/enum checks** in both public and service validators; do not add a schema migration.
- [ ] **Step 4: Re-run `pnpm exec tsx --test apps/app-service/test/model-config.test.ts`** and confirm old fixtures plus the new cases pass.

### Task 2: Bind capabilities to route identity and Responses encoding

**Files:**
- Modify: `apps/app-service/src/models/config.ts`
- Modify: `apps/app-service/src/models/types.ts`
- Modify: `apps/app-service/src/models/client.ts`
- Modify: `apps/app-service/src/models/common.ts`
- Modify: `apps/app-service/src/models/responses.ts`
- Test: `apps/app-service/test/model-config.test.ts`
- Test: `apps/app-service/test/model-protocols.test.ts`

**Interfaces:**
- `resolveRoute(...)` returns a cloned immutable modality array and optional reasoning level.
- A route fingerprint changes when model ID, reasoning level, or input modalities change.
- `ModelMessage` user content accepts bounded text/image/PDF parts only for `purpose: 'text-chat'`; non-Responses adapters reject non-text parts before network dispatch.

- [ ] **Step 1: Add failing route tests** proving the legacy route has no capabilities, each new field affects the fingerprint, and a stale selection fails with `route_changed`.
- [ ] **Step 2: Add failing encoder tests** asserting Responses emits only allowlisted `reasoning.effort`, `input_image`, and `input_file` fields, while Chat Completions/Anthropic/Gemini reject image/PDF content.
- [ ] **Step 3: Implement route snapshot cloning/fingerprinting and Responses-only encoding**; preserve existing text/reference-data formatting and the `store: false` invariant.
- [ ] **Step 4: Run `pnpm exec tsx --test apps/app-service/test/model-config.test.ts apps/app-service/test/model-protocols.test.ts`**.

### Task 3: Recompose the editor without dropping existing model controls

**Files:**
- Modify: `apps/workspace-ui/src/ModelEditorDialog.tsx`
- Modify: `apps/workspace-ui/src/ModelConnectionEditor.tsx`
- Modify: `apps/workspace-ui/src/ModelParameters.tsx`
- Modify: `apps/workspace-ui/src/models.css`
- Test: `apps/workspace-ui/test/model-workspace.test.ts`

**Interfaces:**
- Keep `ModelEditorDialog` props and controller APIs unchanged.
- Keep provider/custom segmented modes, discovery, save, explicit post-save test consent, Key detach flow, global default action, and clear-default confirmation.
- Render every connected-model compatibility field and multi-model connection default without the removed `details.model-custom` section.

- [ ] **Step 1: Add failing markup tests** for one 480px-bounded dialog, fixed header/footer with a scrollable body, no “连接选项与高级设置” text, visible auth/compatibility/default controls, reasoning/modality controls, and password input with no `readOnly`/`disabled` state when editing is allowed.
- [ ] **Step 2: Run `pnpm exec tsx --test apps/workspace-ui/test/model-workspace.test.ts`** and verify the layout/field assertions fail against current markup.
- [ ] **Step 3: Move connection auth and compatibility into the main field grid; move connection-default selection beside model parameters; expose per-model reasoning and Responses-only modality controls; remove only the old wrapper; set modal width/max-height to 480/520 CSS px with a responsive single-column breakpoint.**
- [ ] **Step 4: Re-run the focused UI test and confirm connection save/default/discovery semantics remain covered.**

### Task 4: Prove the API Key paste path without adding clipboard access

**Files:**
- Modify: `apps/workspace-ui/src/ModelEditorDialog.tsx` only if a tested renderer-side blocker is found.
- Modify: `apps/desktop/src/main.ts` only if a tested missing native edit command is the root cause.
- Test: `apps/workspace-ui/test/model-workspace.test.ts`
- Test: `apps/desktop/test/model-ipc.test.ts` only if the fixed IPC path changes.

- [ ] **Step 1: Add a regression test for the observed failure mode**: a pasted value must remain in the native password field until submit, reach exactly one `save(id, key, ...)` call, and not enter controller state or list replies. Use only a synthetic test key.
- [ ] **Step 2: Run the test against current code and record whether it fails.** If the available node test harness cannot emulate browser paste, add a focused browser test only after checking the repository’s installed test tooling; do not call `navigator.clipboard` from production code.
- [ ] **Step 3: Trace paste through the focused editable password input and platform edit menu.** Make the smallest fix to the proven blocker; never add clipboard read/write IPC or log pasted values.
- [ ] **Step 4: Verify with the focused regression test.** Real OS clipboard/Keychain behavior remains a manual acceptance item and is not inferred from synthetic events.

**Validation:** `pnpm exec tsx --test apps/workspace-ui/test/model-workspace.test.ts apps/app-service/test/model-config.test.ts apps/app-service/test/model-protocols.test.ts`; `pnpm run typecheck`; then the repository’s cross-platform checks after later plans land.

**Commit:** Omitted; the user has not requested a commit.
