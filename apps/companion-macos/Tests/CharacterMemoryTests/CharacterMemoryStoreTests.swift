import CharacterCore
import CharacterMemory
@testable import CharacterUI
import XCTest

final class CharacterMemoryStoreTests: XCTestCase {
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
        XCTAssertEqual(model.memories.count, 1)
        XCTAssertEqual(model.memories.first?.status, .candidate)
        XCTAssertFalse(model.memories.first?.shareWithOnlineModel ?? true)
        XCTAssertEqual(model.goals.count, 1)
        XCTAssertEqual(model.goals.first?.status, .active)
        XCTAssertEqual(model.goals.first?.steps.count, 4)
        XCTAssertTrue(model.goals.first?.steps.allSatisfy { !$0.isComplete } == true)
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
