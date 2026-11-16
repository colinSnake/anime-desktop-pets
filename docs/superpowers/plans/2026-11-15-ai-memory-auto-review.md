# AI-Assisted Automatic Memory Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit opt-in, batched AI review that auto-confirms only evidence-backed low-risk personal memories and sends uncertain candidates to the existing human review queue.

**Architecture:** The chat workspace owns ephemeral batch scheduling and cancellation; the injected review provider sends only user turns to the selected compatible model. CharacterCore parses and validates quoted evidence and risk decisions, while CharacterMemoryStore persists opt-in settings and stores auto-confirmed or pending entries with sharing disabled. Identity and provenance-less knowledge remain outside automatic writes.

**Tech Stack:** Swift 5.9, SwiftUI/AppKit, SwiftPM, URLSession with URLProtocol test stubs, Markdown-backed CharacterMemoryStore.

**Spec:** `docs/数字个体AI自动审核设计.md`

## Global Constraints

- macOS 13+; keep the existing Swift module boundaries and no new third-party dependencies.
- Automatic review defaults off and requires explicit consent about additional external requests and possible cost.
- Never send assistant text, identity, existing memory, API keys, or full chat transcripts to the review request.
- Only exact user-provided evidence can become a memory; auto-saved memories remain unshared.
- Credentials are rejected; uncertain, sensitive, expired, or conflicting candidates require manual review.
- No automatic identity-core mutation, provenance-less knowledge import, background polling, or chat-history persistence.
- Tests use synthetic turns, synthetic API credentials, mock URLSession responses, and isolated storage only.

---

### Task 1: Define Evidence-Bound Memory Suggestions

**Files:**
- Modify: `apps/companion-macos/Sources/CharacterCore/CharacterMemoryReview.swift`
- Create: `apps/companion-macos/Sources/CharacterCore/CharacterMemorySuggestion.swift`
- Create: `apps/companion-macos/Tests/CharacterCoreTests/CharacterMemorySuggestionTests.swift`

- [x] Add failing tests for valid exact-quote suggestions and invalid evidence IDs, non-substring quotes, disallowed knowledge type, invalid confidence, and candidate limits.
- [x] Run the focused CharacterCore test and confirm the new API is missing or assertions fail for the intended reason.
- [x] Implement bounded suggestion parsing and a deterministic decision that routes auto-confirm, review, duplicate, and reject outcomes.
- [x] Require confidence >= 0.90 and existing memory automation policy for auto-confirm; keep share authorization false.
- [x] Run the focused test and the existing `CharacterCoreTests` suite.

### Task 2: Persist Per-Pet Automatic Review Consent

**Files:**
- Modify: `apps/companion-macos/Sources/CharacterMemory/CharacterMemoryStore.swift`
- Modify: `apps/companion-macos/Tests/CharacterMemoryTests/CharacterMemoryStoreTests.swift`

- [x] Add failing tests for default-off settings, round-trip persistence, per-pet isolation, restrictive file mode, and symlink rejection.
- [x] Run focused storage tests and confirm the new settings API is absent.
- [x] Add a small `automation-settings.json` store inside the validated per-pet character directory, reusing the store's safe file/path primitives.
- [x] Run focused storage tests and existing memory store tests.

### Task 3: Add Isolated Model Review Request

**Files:**
- Modify: `apps/companion-macos/Sources/PetCompanion/ModelProvider.swift`
- Modify: `apps/companion-macos/Sources/PetCompanion/CharacterChatProvider.swift`
- Modify: `apps/companion-macos/Tests/PetCompanionTests/ModelProviderClientTests.swift`

- [x] Add failing URLProtocol tests for the structured request body, user-turn-only payload, no character context/tools, malformed model output, and zero requests for an empty eligible batch.
- [x] Implement a dedicated memory-review completion method with a narrow prompt and bounded JSON response.
- [x] Parse response through the CharacterCore suggestion validator; do not log request or response bodies.
- [x] Run focused provider tests and existing `ModelProviderClientTests`.

### Task 4: Schedule Bounded Review After Chat Replies

**Files:**
- Modify: `apps/companion-macos/Sources/CharacterUI/CharacterWorkspaceModel.swift`
- Modify: `apps/companion-macos/Sources/CharacterUI/CharacterWorkspaceChat.swift`
- Modify: `apps/companion-macos/Sources/PetCompanion/Coordinator.swift`
- Modify: `apps/companion-macos/Tests/CharacterMemoryTests/CharacterChatRequestTests.swift`

- [x] Cover the three-user-turn threshold, maximum six-turn batch, one in-flight request, disable/cancel behavior, and non-blocking reply completion with synthetic tests.
- [x] Add a focused test identifying a local-answer branch and verifying that successful local answers also count toward a review batch.
- [x] Inject a review closure separately from the regular chat reply closure.
- [x] After each successful reply, queue eligible user turns; run at most one background review and discard late results after disable or teardown.
- [x] Apply suggestions through existing `CharacterMemoryReview` and `CharacterMemoryStore` rules; save low-risk candidates confirmed/unshared, uncertain items pending/unshared, duplicates skipped, credentials rejected.
- [x] Run focused chat request tests and related CharacterCore/CharacterMemory suites.

### Task 5: Add Opt-In Control and Review Status

**Files:**
- Modify: `apps/companion-macos/Sources/CharacterUI/CharacterMemoryView.swift`
- Modify: `apps/companion-macos/Sources/CharacterUI/CharacterWorkspaceModel.swift`
- Modify: `apps/companion-macos/Tests/CharacterMemoryTests/CharacterChatRenderingTests.swift`
- Modify: `apps/companion-macos/Tests/CharacterMemoryTests/CharacterChatInteractionTests.swift`

- [x] Add render coverage for disclosure visibility in light/dark and narrow/wide layouts, and exclusion when the online provider is absent. Persisted default-off and opt-in/cancel state are covered in store/chat tests.
- [x] Add a single toggle with explicit external-processing/additional-cost disclosure and status text that does not expose conversation content.
- [x] Keep all AI candidates in existing memory lifecycle UI; preserve review reasons in the candidate provenance shown by the existing editor.
- [x] Add focused rendered appearance tests in light/dark themes and supported widths; the toggle is structurally excluded when no online review provider is injected.

### Task 6: Document, Integrate, and Verify

**Files:**
- Modify: `docs/数字个体与本地记忆方案.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/文档索引.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/实际验证记录.md`

- [x] Update current capability descriptions and distinguish AI auto-review from automatic personality mutation.
- [x] Run full Swift tests, `python3 scripts/check-project.py`, and `git diff --check`.
- [x] Record exact commands, results, warnings, and untested live-service/UI boundaries.
- [x] Confirm no real API request, app launch, install, commit, or push occurred. Existing Contacts-related tests emitted system XPC diagnostics; no chat, memory store, or model credentials were used.

## 2026-11-15 后续：审核调度和生命周期加固

- [x] 先以超时合成测试复现失败后的立即重试，再阻止错误分支重新调度；后续新的成功答复才重试。
- [x] 先复现清空后迟到建议落库、提供器取消后名额不释放，再增加清空/关闭代际失效与取消名额释放。
- [x] 验证关闭后重新开启时旧任务不能清空新任务名额，旧结果不能干扰新会话。
- [x] 先复现积压9条时下一批只携带旧3条，再按 transcript 留存范围裁剪到最新6条。
- [x] 将审核领域调度拆到 `CharacterWorkspaceMemoryReview.swift`；复跑14项聊天请求测试。
- [x] 全量394项 Swift 测试、Release 编译、33项项目检查及本轮验证记录；未进行真实模型、扬声器或窗口验收。

- [x] 以真实存储 actor 屏障复现等待期间清空后旧建议写入，再将单条判定/保存合并为同步 actor 操作；写入前检查取消，最终刷新后复核取消和代际。
- [x] 新增排队取消、存储取消与并发去重测试；定向16项通过，不承诺撤销已完成写入或整批事务。
- [x] 存储竞态修复后最终复跑：396项 Swift 测试通过（0失败、0跳过），Release 编译退出0；33项项目检查通过，`git diff --check` 退出0。详见本轮实际验证记录。
