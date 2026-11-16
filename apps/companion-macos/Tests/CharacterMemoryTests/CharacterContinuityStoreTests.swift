import CharacterCore
import CharacterMemory
import Darwin
@testable import CharacterUI
import XCTest

private final class ImportFailureFileManager: FileManager, @unchecked Sendable {
    private var memoryWrites = 0
    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        if path.contains("/memories/"), path.hasSuffix(".md") {
            memoryWrites += 1
            if memoryWrites == 2 { throw CocoaError(.fileWriteNoPermission) }
        }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
}

final class CharacterContinuityStoreTests: XCTestCase {
    private func root() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }

    func testSyntheticLifecycleFixtureCoversRequiredSafetyAndContinuityCases() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "memory-lifecycle-cases", withExtension: "json", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: url)
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(fixture["schema"] as? Int, 1)
        XCTAssertEqual(fixture["dataPolicy"] as? String, "synthetic-only")
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: Any]])
        let ids = Set(try cases.map { try XCTUnwrap($0["id"] as? String) })
        XCTAssertEqual(ids, Set([
            "add-pending", "duplicate-knowledge", "conflicting-preference", "sensitive-candidate",
            "expired-knowledge", "edit-revokes-approval", "reject-candidate", "restore-revision",
            "delete-purges-history", "relevant-local-recall", "unauthorized-online-context"
        ]))
        XCTAssertTrue(cases.allSatisfy { $0["expected"] is String && $0["area"] is String })
    }

    @MainActor
    func testExistingIdentityCompletionIsPreviewOnlyAndMemoryRefreshKeepsDraft() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let original = CharacterIdentity(name: "自定义龙妹", role: "我的伙伴", personality: "沉稳", shareWithOnlineModel: true)
        try await store.saveIdentity(original)
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹")
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(model.canSaveIdentity)
        XCTAssertFalse(model.identityCompletionFields.isEmpty)
        let beforeApply = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(beforeApply, original)
        model.applyIdentityCompletion()
        XCTAssertFalse(model.identity.background.isEmpty)
        model.identity.values = "本轮尚未保存的价值观"
        model.refreshMemories()
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(model.identity.values, "本轮尚未保存的价值观")
        let beforeSave = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(beforeSave, original)
        let savedForm = model.identity
        model.saveIdentity()
        // The save uses the form snapshot, even if the user continues editing.
        model.identity.role = "保存之后的另一个草稿"
        for _ in 0..<100 where model.status != "身份资料已保存。" { try await Task.sleep(nanoseconds: 10_000_000) }
        let restarted = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let persisted = try await restarted.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(persisted.name, savedForm.name)
        XCTAssertEqual(persisted.role, savedForm.role)
        XCTAssertEqual(persisted.background, savedForm.background)
        XCTAssertEqual(persisted.values, savedForm.values)
        XCTAssertEqual(persisted.revision, savedForm.revision + 1)
        XCTAssertEqual(persisted.name, original.name)
        XCTAssertEqual(persisted.personality, original.personality)
        XCTAssertTrue(persisted.shareWithOnlineModel)
    }

    @MainActor
    func testIdentitySaveRejectsMultilineNameWithClearFeedbackAndPreservesExistingData() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "name-validation")
        let original = CharacterIdentity(name: "小桃", role: "保留背景", values: "保留价值")
        try await store.saveIdentity(original)
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹")
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 10_000_000) }
        for invalid in ["第一行\n第二行", "\n", String(repeating: "字", count: 81)] {
            model.identity.name = invalid
            model.saveIdentity()
            for _ in 0..<100 where model.status.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
            XCTAssertTrue(model.status.contains("名称"), model.status)
            let persisted = try await store.loadIdentity(defaultName: "龙妹")
            XCTAssertEqual(persisted, original)
        }
        model.identity.name = " 小雪 "
        model.identity.personality = "新的性格"
        model.saveIdentity()
        for _ in 0..<100 where model.status != "身份资料已保存。" { try await Task.sleep(nanoseconds: 10_000_000) }
        let saved = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(saved.name, "小雪")
        XCTAssertEqual(saved.personality, "新的性格")
        XCTAssertEqual(saved.role, original.role)
        XCTAssertEqual(saved.values, original.values)
    }

    func testGoalSharingPersistsAndLegacyMarkdownAndJSONDefaultToLocal() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let goal = CharacterGoal(title: "整理书房", steps: [.init(text: "分类", isComplete: true)], shareWithOnlineModel: true)
        try await store.saveGoal(goal)
        let loaded = try await store.listGoals()
        XCTAssertTrue(try XCTUnwrap(loaded.first).shareWithOnlineModel)
        let url = directory.appendingPathComponent("pets/white-dragon/character/plans/\(goal.id).md")
        let current = try String(contentsOf: url, encoding: .utf8)
        let legacy = current.replacingOccurrences(of: "\"schema\" : 2", with: "\"schema\" : 1")
            .replacingOccurrences(of: "  \"shareWithOnlineModel\" : true,\n", with: "")
        XCTAssertNotEqual(current, legacy)
        try legacy.write(to: url, atomically: true, encoding: .utf8)
        let legacyGoals = try await store.listGoals()
        XCTAssertFalse(try XCTUnwrap(legacyGoals.first).shareWithOnlineModel)
        XCTAssertEqual(legacyGoals.first?.steps, goal.steps)
        let data = try JSONEncoder().encode(goal)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "shareWithOnlineModel")
        let decoded = try JSONDecoder().decode(CharacterGoal.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertFalse(decoded.shareWithOnlineModel)
    }

    func testKnowledgeImportRestartDedupConfirmationAndEditRevokesApproval() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let expiry = Date(timeIntervalSince1970: floor(Date.now.timeIntervalSince1970) + 86_400.75)
        let first = try await store.importKnowledge(text: "书房收纳先分类\n\n盒子应贴标签\n\n书房收纳先分类", source: "合成手册", citation: "§1", version: "v1", expiresAt: expiry)
        XCTAssertEqual(first.imported, 2)
        let restarted = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        var records = try await restarted.listMemories()
        XCTAssertEqual(records.count, 2)
        XCTAssertTrue(records.allSatisfy { $0.status == .candidate && !$0.shareWithOnlineModel && $0.expiresAt != nil })
        let second = try await restarted.importKnowledge(text: "书房收纳先分类\n\n盒子应贴标签", source: "合成手册", citation: "§1", version: "v1", expiresAt: expiry)
        XCTAssertEqual(second.imported, 0); XCTAssertEqual(second.skipped, 2)
        for record in records { try await restarted.confirmMemory(id: record.id, shareWithOnlineModel: true) }
        records = try await restarted.listMemories()
        XCTAssertEqual(Set(records.map(\.citation)).count, 2)
        XCTAssertTrue(records.allSatisfy { !CharacterMemoryReview.hasUnresolvedKnowledgeConflict($0, against: records) })
        let context = try XCTUnwrap(CharacterContextBuilder.make(identity: nil, memories: records, query: "合成手册"))
        XCTAssertTrue(context.contains("书房收纳先分类")); XCTAssertTrue(context.contains("盒子应贴标签"))
        let item = try XCTUnwrap(records.first)
        try await restarted.confirmMemory(id: item.id, shareWithOnlineModel: true)
        records = try await restarted.listMemories()
        XCTAssertEqual(records.first { $0.id == item.id }?.status, .confirmed)
        for change in ["text", "source", "citation", "version", "expiry"] {
            var edited = try XCTUnwrap(records.first { $0.id == item.id })
            switch change {
            case "text": edited.text += "，再检查"
            case "source": edited.source += "修订"
            case "citation": edited.citation += "b"
            case "version": edited.version += ".1"
            default: edited.expiresAt = edited.expiresAt?.addingTimeInterval(60)
            }
            try await restarted.saveMemory(edited)
            records = try await restarted.listMemories()
            let pending = try XCTUnwrap(records.first { $0.id == item.id })
            XCTAssertEqual(pending.status, .candidate, change)
            XCTAssertFalse(pending.shareWithOnlineModel, change)
            XCTAssertNil(CharacterContextBuilder.make(identity: nil, memories: [pending], query: pending.text))
            try await restarted.confirmMemory(id: item.id, shareWithOnlineModel: true)
            records = try await restarted.listMemories()
        }
    }

    func testMemoryEditsCreateRestorableRevisionsAndDeletePurgesHistory() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        var memory = CharacterMemory(kind: .preference, text: "喜欢安静",
                                     createdAt: Date.now.addingTimeInterval(-60), source: "用户明确要求", status: .confirmed,
                                     shareWithOnlineModel: true)
        try await store.saveMemory(memory)

        memory.text = "喜欢安静的书房"
        try await store.saveMemory(memory)
        let initialRecords = try await store.listMemories()
        var current = try XCTUnwrap(initialRecords.first)
        XCTAssertEqual(current.status, .candidate)
        XCTAssertFalse(current.shareWithOnlineModel)
        XCTAssertEqual(current.revision, 2)
        XCTAssertGreaterThan(current.updatedAt, current.createdAt)

        let history = try await store.memoryHistory(id: memory.id)
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].text, "喜欢安静")
        XCTAssertEqual(history[0].status, .confirmed)

        try await store.restoreMemoryRevision(id: memory.id, revision: history[0].revision)
        let restoredRecords = try await store.listMemories()
        current = try XCTUnwrap(restoredRecords.first)
        XCTAssertEqual(current.text, "喜欢安静")
        XCTAssertEqual(current.status, .candidate)
        XCTAssertFalse(current.shareWithOnlineModel)
        let restoredHistory = try await store.memoryHistory(id: memory.id)
        XCTAssertEqual(restoredHistory.count, 2)

        try await store.deleteMemory(id: memory.id)
        let deletedHistory = try await store.memoryHistory(id: memory.id)
        XCTAssertTrue(deletedHistory.isEmpty)
    }

    func testMemoryHistoryRetainsOnlyTenNewestSnapshots() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "history-limit")
        var memory = CharacterMemory(kind: .fact, text: "版本 0", source: "合成测试")
        try await store.saveMemory(memory)
        for revision in 1...12 {
            memory.text = "版本 \(revision)"
            try await store.saveMemory(memory)
        }

        let history = try await store.memoryHistory(id: memory.id)
        XCTAssertEqual(history.count, 10)
        XCTAssertEqual(history.map(\.revision), Array(3...12))
    }

    func testConfirmingMemoryRecordsConfirmationTimestamp() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let memory = CharacterMemory(kind: .fact, text: "只用合成测试资料", source: "用户添加")
        try await store.saveMemory(memory)
        try await store.confirmMemory(id: memory.id)
        let savedRecords = try await store.listMemories()
        let saved = try XCTUnwrap(savedRecords.first)
        XCTAssertEqual(saved.status, .confirmed)
        XCTAssertNotNil(saved.confirmedAt)
    }

    func testIdentityEditsAreVersionedAndCanBeRestoredWithoutOnlineAuthorization() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        var identity = CharacterIdentity(name: "龙妹", personality: "简洁直率", shareWithOnlineModel: true)
        try await store.saveIdentity(identity)
        identity = try await store.loadIdentity(defaultName: "龙妹")
        identity.personality = "先问清楚再回答"
        identity.shareWithOnlineModel = true
        try await store.saveIdentity(identity)

        let updated = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(updated.revision, 2)
        XCTAssertEqual(updated.personality, "先问清楚再回答")
        let history = try await store.identityHistory()
        XCTAssertEqual(history.map(\.personality), ["简洁直率"])

        try await store.restoreIdentityRevision(revision: history[0].revision)
        let restored = try await store.loadIdentity(defaultName: "龙妹")
        XCTAssertEqual(restored.personality, "简洁直率")
        XCTAssertFalse(restored.shareWithOnlineModel)
        XCTAssertEqual(restored.revision, 3)
    }

    @MainActor
    func testIdentityHistoryIsAvailableAndRestorableThroughWorkspaceModel() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "identity-history")
        try await store.saveIdentity(CharacterIdentity(name: "龙妹", personality: "原始性格",
                                                        shareWithOnlineModel: true))
        var edited = try await store.loadIdentity(defaultName: "龙妹")
        edited.personality = "修改后的性格"
        try await store.saveIdentity(edited)

        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹")
        for _ in 0..<100 where model.identityHistory.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.identityHistory.map(\.personality), ["原始性格"])

        model.restoreIdentityRevision(1)
        for _ in 0..<100 where model.status != "已恢复身份版本；在线分享已关闭，请检查后重新授权。" {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.identity.personality, "原始性格")
        XCTAssertFalse(model.identity.shareWithOnlineModel)
        XCTAssertEqual(model.identity.revision, 3)
    }

    func testExpiredKnowledgeCannotBeConfirmedAndOldSchemasHaveNoExpiry() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let expired = CharacterMemory(kind: .knowledge, text: "合成过期知识", source: "手册", expiresAt: .now.addingTimeInterval(-60))
        try await store.saveMemory(expired)
        do { try await store.confirmMemory(id: expired.id); XCTFail("Expired knowledge must require renewal") }
        catch CharacterKnowledgeImportError.expired {}
        let pending = try await store.listMemories()
        XCTAssertEqual(pending.first?.status, .candidate)
        for schema in [1, 2] {
            let id = UUID().uuidString
            let url = directory.appendingPathComponent("pets/white-dragon/character/memories/\(id).md")
            let legacy = "---\n{\"schema\":\(schema),\"id\":\"\(id)\",\"kind\":\"知识\",\"createdAt\":\"2026-11-08T00:00:00Z\",\"source\":\"legacy\",\"status\":\"confirmed\",\"shareWithOnlineModel\":false}\n---\n\n旧知识\n"
            try legacy.write(to: url, atomically: true, encoding: .utf8)
        }
        let records = try await store.listMemories()
        XCTAssertEqual(records.filter { $0.text == "旧知识" && $0.expiresAt == nil }.count, 2)
    }

    func testInvalidBatchAndWriteFailureLeaveNoPartialKnowledgeAndKeepExistingRecord() async throws {
        let directory = root()
        defer { try? FileManager.default.removeItem(at: directory) }
        let initial = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let original = CharacterMemory(kind: .fact, text: "已存在的资料", source: "合成资料", status: .confirmed)
        try await initial.saveMemory(original)
        do {
            _ = try await initial.importKnowledge(text: "合法第一段\n\n" + String(repeating: "长", count: 1001), source: "手册")
            XCTFail("Entire batch should be validated before writes")
        } catch CharacterKnowledgeImportError.invalidText {}
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon", fileManager: ImportFailureFileManager())
        do {
            _ = try await store.importKnowledge(text: "第一段\n\n第二段", source: "手册")
            XCTFail("Injected permissions failure should propagate")
        } catch let error as CocoaError { XCTAssertEqual(error.code, .fileWriteNoPermission) }
        let records = try await initial.listMemories()
        XCTAssertEqual(records.map(\.id), [original.id])
    }

    func testSelectedKnowledgeFileReadIsBoundedAndRejectsLinksFIFOsAndInvalidUTF8() async throws {
        let directory = root()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "white-dragon")
        let good = directory.appendingPathComponent("sample.md")
        try "知识正文".write(to: good, atomically: true, encoding: .utf8)
        let loaded = try await store.loadKnowledgeImportText(from: good)
        XCTAssertEqual(loaded, "知识正文")
        let link = directory.appendingPathComponent("link.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: good)
        let fifo = directory.appendingPathComponent("pipe.txt")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let oversized = directory.appendingPathComponent("oversized.txt")
        try Data(repeating: 65, count: CharacterKnowledgeImport.maxBytes + 1).write(to: oversized)
        let invalid = directory.appendingPathComponent("invalid.txt")
        try Data([0xff, 0xfe]).write(to: invalid)
        for url in [link, fifo, oversized, invalid] {
            do { _ = try await store.loadKnowledgeImportText(from: url); XCTFail("Expected rejection for \(url.lastPathComponent)") }
            catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        }
        let records = try await store.listMemories()
        XCTAssertTrue(records.isEmpty)
    }
}
