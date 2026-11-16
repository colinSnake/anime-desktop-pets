# Memory Lifecycle and Reviewed Revision Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make user-authored identity, memory, and knowledge edits auditable and reversible without background learning or autonomous personality changes.

**Architecture:** Extend the existing per-pet Markdown records with backward-compatible lifecycle metadata. Preserve prior records in a bounded local revision archive. Edits to memory/knowledge return the active record to pending review and disable online sharing; restoring history writes a new revision rather than rewinding revision numbers. The UI shows provenance and before/after differences; deletion purges that record's revision archive. Model-generated proposals and automatic extraction are explicitly outside this milestone.

**Tech Stack:** Swift 5.9, SwiftPM, Foundation actors, Markdown/front matter, SwiftUI, XCTest.

**Spec:** `docs/数字个体与本地记忆方案.md`, `docs/龙妹聊天与记忆验收.md`

## Global Constraints

- macOS 13+; per-pet data remains under the existing local Application Support directory.
- Existing schema 1-3 Markdown memory records remain readable; missing lifecycle fields receive safe defaults.
- Memory, knowledge, and identity remain local unless explicitly authorized for online use.
- No background model calls, automatic extraction from ordinary conversation, autonomous identity edits, or goal execution.
- Credentials remain rejected; knowledge edits still require review and renewed share authorization.
- Physical deletion removes active data and its revision archive; update rollback does not restore deleted records.
- Do not use real user conversations, credentials, or external model calls in automated tests.

---

### Task 1: Lifecycle Model and Backward-Compatible Codec

**Files:**
- Modify: `apps/companion-macos/Sources/CharacterCore/CharacterMemory.swift`
- Modify: `apps/companion-macos/Sources/CharacterMemory/CharacterMarkdownCodec.swift`
- Test: `apps/companion-macos/Tests/CharacterCoreTests/CharacterCoreTests.swift`
- Test: `apps/companion-macos/Tests/CharacterMemoryTests/CharacterMemoryStoreTests.swift`

- [x] Add tests for created/updated/confirmed metadata defaults and old-schema decoding.
- [x] Run tests and confirm lifecycle assertions fail for missing fields.
- [x] Add lifecycle timestamps with explicit decoder defaults.
- [x] Bump encoded schemas and retain legacy reads.
- [x] Run focused model/codec tests.

### Task 2: Revision Archive and Restore

**Files:**
- Modify: `apps/companion-macos/Sources/CharacterMemory/CharacterMemoryStore.swift`
- Test: `apps/companion-macos/Tests/CharacterMemoryTests/CharacterContinuityStoreTests.swift`

- [x] Test edits, restore, deletion, credential rejection, path protections, and history retention limits.
- [x] Run tests and verify new lifecycle assertions fail before implementation.
- [x] Implement bounded revision archive (latest 10 snapshots per record), history listing and restore.
- [x] Ensure changed knowledge returns to pending and unshared.
- [x] Run storage tests including symlink/path and credential rejection regressions.

### Task 3: User-Triggered Revision Review UI

**Files:**
- Modify: `apps/companion-macos/Sources/CharacterUI/CharacterWorkspaceModel.swift`
- Modify: `apps/companion-macos/Sources/CharacterUI/CharacterIdentityView.swift`
- Modify: `apps/companion-macos/Sources/CharacterUI/CharacterMemoryView.swift`
- Test: `apps/companion-macos/Tests/CharacterMemoryTests/CharacterMemoryStoreTests.swift`

- [x] Show identity history in the identity page and memory history in each memory row, with explicit restore actions.
- [x] Show before/after deltas for content and knowledge provenance/expiry/sharing changes.
- [x] Surface history-loading errors and label deletion as permanent for app-managed history.
- [x] Keep personality edits user-authored; no AI recommendations or background extraction are added.
- [x] Run SwiftUI model and relevant view compilation/tests.

### Task 4: Evaluation Fixtures and Documentation

**Files:**
- Create: `apps/companion-macos/Tests/CharacterMemoryTests/Fixtures/memory-lifecycle-cases.json`
- Modify: `docs/数字个体与本地记忆方案.md`
- Modify: `docs/龙妹聊天与记忆验收.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/实际验证记录.md`
- Modify: `docs/prd.md`, architecture decision, document index, and English/Chinese README

- [x] Add synthetic lifecycle and authorization fixture cases.
- [x] Cover restore, delete, expiry, credential rejection, deduplication, and authorized retrieval with offline tests.
- [x] Document this milestone as user-authored revision, not autonomous or model-generated learning.
- [x] Run full targeted tests, `python3 scripts/check-project.py`, and `git diff --check` after integration.
- [x] Record exact pass/fail and unverified UI/online boundaries.
