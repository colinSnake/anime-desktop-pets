import CharacterCore
import CharacterMemory
@testable import CharacterUI
import XCTest

final class CharacterMemoryStoreTests: XCTestCase {
    @MainActor
    func testWorkspaceRejectsCredentialMemorySynchronouslyAndKeepsVisibleReason() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹")

        let accepted = model.addMemory(text: "安全说明", kind: .knowledge,
                                       source: "手册", citation: "API key: do-not-store")

        XCTAssertFalse(accepted)
        XCTAssertTrue(model.status.contains("未保存"))
        let memories = try await store.listMemories()
        XCTAssertTrue(memories.isEmpty)
    }

    @MainActor
    func testWorkspaceCredentialEditShowsFailureAndKeepsPersistedMemoryUnchanged() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let original = CharacterMemory(kind: .knowledge, text: "安全说明", source: "用户确认",
                                       citation: "手册 §1", status: .confirmed)
        try await store.saveMemory(original)
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹")
        for _ in 0..<100 where model.memories.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        var edited = try XCTUnwrap(model.memories.first)
        edited.citation = "API key: do-not-store"

        model.update(edited)
        for _ in 0..<100 where !model.status.contains("未保存") {
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertTrue(model.status.contains("未保存"))
        let persisted = try await store.listMemories()
        XCTAssertEqual(persisted.first?.citation, "手册 §1")
        XCTAssertEqual(persisted.first?.text, "安全说明")
    }

    @MainActor
    func testFailedChatCanBeRetriedWithoutDuplicatingUserTurn() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        var calls = 0
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹", chat: { _, _ in
            calls += 1
            if calls == 1 { throw NSError(domain: "test", code: 1) }
            return "第二次回复"
        })

        model.sendChat("你好")
        for _ in 0..<100 where model.failedChatText == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.chatTurns.map(\.text), ["你好"])
        XCTAssertEqual(model.failedChatText, "你好")

        model.retryFailedChat()
        for _ in 0..<100 where model.isChatSending || model.chatTurns.count < 2 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(model.chatTurns.map(\.text), ["你好", "第二次回复"])
        XCTAssertNil(model.failedChatText)
    }

    @MainActor
    func testLongmeiRepositoryExamplesLoadThroughCharacterWorkspaceModel() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        _ = try await store.loadIdentity(defaultName: "龙妹")

        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../../", isDirectory: true)
            .standardizedFileURL
        let examples = repositoryRoot.appendingPathComponent("docs/examples/龙妹角色资料", isDirectory: true)
        let characterRoot = root.appendingPathComponent("pets/white-dragon/character", isDirectory: true)
        try FileManager.default.copyItem(at: examples.appendingPathComponent("identity.md"),
                                         to: characterRoot.appendingPathComponent("identity.md"))
        try FileManager.default.copyItem(
            at: examples.appendingPathComponent("memories/示例-角色约定.md"),
            to: characterRoot.appendingPathComponent("memories/a31ed427-88fc-4a49-b0bc-0b71a7311d2c.md")
        )
        try FileManager.default.copyItem(
            at: examples.appendingPathComponent("plans/示例-建立可信赖的角色记忆.md"),
            to: characterRoot.appendingPathComponent("plans/9f0ca44a-78bc-4bcf-bf7b-63cbcfd0ab16.md")
        )

        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹")
        model.refreshGoals()
        for _ in 0..<100 where !model.canSaveIdentity || model.memories.isEmpty || model.goals.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertTrue(model.canSaveIdentity)
        XCTAssertEqual(model.identity.name, "龙妹")
        XCTAssertFalse(model.identity.role.isEmpty)
        XCTAssertFalse(model.identity.values.isEmpty)
        XCTAssertEqual(model.identity, .starter(name: "龙妹"))
        XCTAssertEqual(model.memories.count, 1)
        XCTAssertEqual(model.memories.first?.status, .candidate)
        XCTAssertFalse(model.memories.first?.shareWithOnlineModel ?? true)
        XCTAssertEqual(model.goals.count, 1)
        XCTAssertEqual(model.goals.first?.status, .active)
        XCTAssertEqual(model.goals.first?.steps.count, 4)
        XCTAssertTrue(model.goals.first?.steps.allSatisfy { !$0.isComplete } == true)
    }

    func testNewPresetRoundTripsWithoutReplacingExistingIdentityOrSeedingUserMemories() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let preset = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(preset, .starter(name: "龙妹"))
        let memories = try await store.listMemories()
        let goals = try await store.listGoals()
        XCTAssertTrue(memories.isEmpty)
        XCTAssertTrue(goals.isEmpty)
        try await store.saveIdentity(preset)
        let reloaded = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(reloaded, preset)
        let custom = CharacterIdentity(name: "龙妹", personality: "用户自己填写的性格")
        try await store.saveIdentity(custom)
        let preserved = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(preserved, custom)
    }

    func testIdentityAndMemoryRoundTripAndConfirmation() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let identity = CharacterIdentity(name: "龙妹", role: "桌边伙伴", personality: "直率",
                                         values: "诚实", motivations: "陪用户完成目标",
                                         relationship: "并肩伙伴", knowledgeScope: "不确定时直接说明",
                                         shareWithOnlineModel: true)
        try await store.saveIdentity(identity)

        let candidate = CharacterMemory(kind: .preference, text: "先给方案再实现", source: "语音明确指令")
        try await store.saveMemory(candidate)
        try await store.confirmMemory(id: candidate.id, shareWithOnlineModel: true)

        let loadedIdentity = try await store.loadIdentity(defaultName: "其他")
        XCTAssertEqual(loadedIdentity, identity)
        let loaded = try await store.listMemories()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.status, .confirmed)
        XCTAssertEqual(loaded.first?.text, candidate.text)
        XCTAssertTrue(loaded.first?.shareWithOnlineModel == true)

        let markdown = try String(contentsOf: root.appendingPathComponent("pets/white-dragon/character/identity.md"), encoding: .utf8)
        XCTAssertTrue(markdown.hasPrefix("---\n"))
        XCTAssertTrue(markdown.contains("# 龙妹"))

        let edited = markdown.replacingOccurrences(of: "## 性格\n直率", with: "## 性格\n冷静但直率")
        try edited.write(to: root.appendingPathComponent("pets/white-dragon/character/identity.md"), atomically: true, encoding: .utf8)
        let reloaded = try await store.loadIdentity(defaultName: "其他")
        XCTAssertEqual(reloaded.personality, "冷静但直率")
    }

    func testCredentialLikeMemoryContentOrProvenanceIsRejectedBeforeWriting() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let candidates = [
            CharacterMemory(kind: .fact, text: "API key: do-not-store", source: "manual"),
            CharacterMemory(kind: .knowledge, text: "safe text", source: "token reference"),
            CharacterMemory(kind: .knowledge, text: "safe text", source: "manual", citation: "cookie-secret"),
            CharacterMemory(kind: .knowledge, text: "safe text", source: "manual", version: "私钥"),
        ]

        for candidate in candidates {
            do {
                try await store.saveMemory(candidate)
                XCTFail("Expected credential-like memory to be rejected")
            } catch CharacterMemoryStoreError.credentialLikeRecord {
                let file = root.appendingPathComponent(
                    "pets/white-dragon/character/memories/\(candidate.id).md"
                )
                XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
            }
        }
        let memories = try await store.listMemories()
        XCTAssertTrue(memories.isEmpty)
    }

    func testKnowledgeProvenanceRoundTripsAndLegacyMemoryStillLoads() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        _ = try await store.loadIdentity(defaultName: "龙妹")

        let knowledge = CharacterMemory(id: "11111111-1111-1111-1111-111111111111", kind: .knowledge,
                                        text: "复杂问题先拆成小步骤", source: "用户确认的角色设定",
                                        citation: "角色手册 §2.1", version: "2026-11-08",
                                        status: .confirmed, shareWithOnlineModel: true)
        try await store.saveMemory(knowledge)
        let loaded = try await store.listMemories()
        XCTAssertEqual(loaded.first?.citation, "角色手册 §2.1")
        XCTAssertEqual(loaded.first?.version, "2026-11-08")

        let legacyID = "22222222-2222-2222-2222-222222222222"
        let legacyURL = root.appendingPathComponent("pets/white-dragon/character/memories/\(legacyID).md")
        let legacy = """
        ---
        {"schema":1,"id":"\(legacyID)","kind":"事实","createdAt":"2026-11-08T00:00:00Z","source":"legacy","status":"confirmed","shareWithOnlineModel":false}
        ---

        旧格式资料
        """
        try legacy.write(to: legacyURL, atomically: true, encoding: .utf8)

        let all = try await store.listMemories()
        let loadedLegacy = try XCTUnwrap(all.first { $0.id == legacyID })
        XCTAssertEqual(loadedLegacy.text, "旧格式资料")
        XCTAssertEqual(loadedLegacy.citation, "")
        XCTAssertEqual(loadedLegacy.version, "")
    }

    func testIdentityNameIsNormalizedBeforeWritingMarkdown() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        try await store.saveIdentity(CharacterIdentity(name: "  龙妹  ", background: "守护桌面"))

        let identity = try await store.loadIdentity(defaultName: "未命名")

        XCTAssertEqual(identity.name, "龙妹")
        XCTAssertEqual(identity.background, "守护桌面")
    }

    func testLegacyIdentityMarkdownLoadsWithEmptyNewPersonalityFields() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        _ = try await store.loadIdentity(defaultName: "龙妹")
        let url = root.appendingPathComponent("pets/white-dragon/character/identity.md")
        let legacy = """
        ---
        {"schema":1,"shareWithOnlineModel":false}
        ---

        # 龙妹

        ## 背景
        来自东方

        ## 性格
        直率

        ## 表达方式
        温柔

        ## 边界
        不乱承诺
        """
        try legacy.write(to: url, atomically: true, encoding: .utf8)

        let identity = try await store.loadIdentity(defaultName: "其他")

        XCTAssertEqual(identity.name, "龙妹")
        XCTAssertEqual(identity.background, "来自东方")
        XCTAssertEqual(identity.personality, "直率")
        XCTAssertEqual(identity.role, "")
        XCTAssertEqual(identity.values, "")
    }

    func testPetDataIsIsolatedAndDeleteIsHardDelete() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let second = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon-copy")
        let item = CharacterMemory(kind: .fact, text: "only first", source: "test")
        try await first.saveMemory(item)

        let secondMemories = try await second.listMemories()
        XCTAssertTrue(secondMemories.isEmpty)
        try await first.deleteMemory(id: item.id)
        let firstMemories = try await first.listMemories()
        XCTAssertTrue(firstMemories.isEmpty)
    }

    func testGoalPlanRoundTripProgressEditAndDelete() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        var goal = CharacterGoal(title: "整理角色设定", details: "先完成可控的小步骤", steps: [
            CharacterGoal.Step(text: "整理现有设定", isComplete: true),
            CharacterGoal.Step(text: "确认长期边界"),
        ])
        goal.status = .paused
        try await store.saveGoal(goal)

        let planURL = root.appendingPathComponent("pets/white-dragon/character/plans/\(goal.id).md")
        let markdown = try String(contentsOf: planURL, encoding: .utf8)
        XCTAssertTrue(markdown.contains("- [x] 1. 整理现有设定"))
        XCTAssertTrue(markdown.contains("- [ ] 2. 确认长期边界"))
        var loaded = try await store.listGoals()
        XCTAssertEqual(loaded.first?.id, goal.id)
        XCTAssertEqual(loaded.first?.title, goal.title)
        XCTAssertEqual(loaded.first?.details, goal.details)
        XCTAssertEqual(loaded.first?.status, goal.status)
        XCTAssertEqual(loaded.first?.steps.map(\.text), goal.steps.map(\.text))
        XCTAssertEqual(loaded.first?.steps.map(\.isComplete), goal.steps.map(\.isComplete))

        loaded[0].steps[1].isComplete = true
        loaded[0].status = .completed
        try await store.saveGoal(loaded[0])
        let updated = try await store.listGoals()
        XCTAssertEqual(updated.first?.completedStepCount, 2)
        XCTAssertEqual(updated.first?.status, .completed)

        try await store.deleteGoal(id: goal.id)
        let afterDelete = try await store.listGoals()
        XCTAssertTrue(afterDelete.isEmpty)
    }

    func testRejectsGoalWithDuplicateStepIdentifiers() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let duplicate = UUID().uuidString.lowercased()
        let goal = CharacterGoal(title: "不合法", steps: [
            CharacterGoal.Step(id: duplicate, text: "第一步"),
            CharacterGoal.Step(id: duplicate, text: "第二步"),
        ])

        do {
            try await store.saveGoal(goal)
            XCTFail("Expected invalid goal to be rejected")
        } catch CharacterMemoryStoreError.invalidRecord {
            let goals = try await store.listGoals()
            XCTAssertTrue(goals.isEmpty)
        }
    }

    func testRejectsStepTextThatConflictsWithMarkdownIdentifierMarker() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let goal = CharacterGoal(title: "格式校验", steps: [
            CharacterGoal.Step(text: "包含 <!-- 注释边界 --> 的步骤"),
        ])

        do {
            try await store.saveGoal(goal)
            XCTFail("Expected ambiguous Markdown step text to be rejected")
        } catch CharacterMemoryStoreError.invalidRecord {
            let goals = try await store.listGoals()
            XCTAssertTrue(goals.isEmpty)
        }
    }

    func testMarkdownBodyIsTheMemoryTextSource() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let item = CharacterMemory(kind: .fact, text: "original", source: "test")
        try await store.saveMemory(item)
        let file = root.appendingPathComponent("pets/white-dragon/character/memories/\(item.id).md")
        var markdown = try String(contentsOf: file, encoding: .utf8)
        markdown = markdown.replacingOccurrences(of: "\n\noriginal\n", with: "\n\nchanged in editor\n")
        try markdown.write(to: file, atomically: true, encoding: .utf8)

        let loaded = try await store.listMemories()
        XCTAssertEqual(loaded.first?.text, "changed in editor")
    }

    func testRejectsPetDirectorySymlink() async throws {
        let root = temporaryDirectory()
        let outside = temporaryDirectory()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }
        let pets = root.appendingPathComponent("pets", isDirectory: true)
        try FileManager.default.createDirectory(at: pets, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: pets.appendingPathComponent("white-dragon"), withDestinationURL: outside)
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")

        do {
            _ = try await store.listMemories()
            XCTFail("Expected symbolic-link path to be rejected")
        } catch CharacterMemoryStoreError.unsafePath {
            XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("character").path))
        }
    }

    func testRejectsUnsafePetIdentifier() {
        XCTAssertThrowsError(try CharacterMemoryStore(stateDirectory: temporaryDirectory(), petID: "../outside"))
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }
}
