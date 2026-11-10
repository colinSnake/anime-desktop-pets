import CharacterCore
import CharacterMemory
import Foundation
import XCTest
@testable import DragonCompanion

@MainActor
final class CharacterOfflineFlowTests: XCTestCase {
    func testNormalModeLocalAnswersNeverLoadProviderOrCallCompletion() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var loads = 0
        var completions = 0
        let provider = CharacterChatProvider(credentials: { _ in
            loads += 1
            throw ModelProviderError.missingAPIKey
        }, complete: { _, _, _, _, _ in
            completions += 1
            XCTFail("Local answers must not enter online completion")
            return "unexpected"
        })
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()),
                                      mode: .controlTest, characterChatProvider: provider)
        for question in ["你是谁", "你会什么", "记住：合成偏好是安静的书房", "你记得什么",
                         "我们现在推进到哪一步了", "你知道哪些角色知识"] {
            let reply = try await coordinator.replyToCharacterChat(question, history: [], memorySource: "用户语音明确指令")
            XCTAssertFalse(reply.isEmpty)
        }
        XCTAssertEqual(loads, 0)
        XCTAssertEqual(completions, 0)
    }

    func testVoiceOnlineRoutingUsesMockOnceAndFiltersPrivatePendingAndExpiredContext() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let runtime = Runtime(resources: root, state: root, configuration: .init())
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        var identity = CharacterIdentity.starter(name: "龙妹")
        identity.shareWithOnlineModel = true
        try await store.saveIdentity(identity)
        let shared = CharacterMemory(kind: .knowledge, text: "合成书房标签使用蓝色", source: "合成手册",
                                     status: .confirmed, shareWithOnlineModel: true)
        let privateMemory = CharacterMemory(kind: .fact, text: "合成书房私有编号", source: "合成样本", status: .confirmed)
        let pending = CharacterMemory(kind: .knowledge, text: "合成书房待审编号", source: "合成样本", shareWithOnlineModel: true)
        let expired = CharacterMemory(kind: .knowledge, text: "合成书房过期编号", source: "合成样本", status: .confirmed,
                                      shareWithOnlineModel: true, expiresAt: .now.addingTimeInterval(-60))
        for memory in [shared, privateMemory, pending, expired] { try await store.saveMemory(memory) }
        var loads = 0
        var completions = 0
        let provider = CharacterChatProvider(credentials: { received in
            loads += 1
            XCTAssertEqual(received.state, root)
            return (ModelProviderSettings(), "synthetic-fixture-token")
        }, complete: { _, token, text, context, history in
            completions += 1
            XCTAssertEqual(token, "synthetic-fixture-token")
            XCTAssertEqual(text, "请帮我规划合成书房标签配色")
            XCTAssertTrue(history.isEmpty)
            let payload = try XCTUnwrap(context)
            XCTAssertTrue(payload.contains(shared.text))
        XCTAssertTrue(payload.contains("名字：龙妹"))
            for excluded in [privateMemory, pending, expired] { XCTAssertFalse(payload.contains(excluded.text)) }
            return "合成 mock 回复：按蓝色标签整理书房。"
        })
        let coordinator = Coordinator(runtime: runtime, mode: .controlTest, characterChatProvider: provider)
        let reply = try await coordinator.replyToCharacterChat("请帮我规划合成书房标签配色", history: [],
                                                              memorySource: "用户语音明确指令")
        XCTAssertEqual(SpeechReplyText.prepare(reply), reply)
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(completions, 1)
    }

    func testOfflinePreviewRejectsOnlineQuestionBeforeInjectedProvider() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let provider = CharacterChatProvider(credentials: { _ in
            XCTFail("Preview must not inspect provider credentials")
            throw ModelProviderError.missingAPIKey
        }, complete: { _, _, _, _, _ in
            XCTFail("Preview must not call online completion")
            return "unexpected"
        })
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()),
                                      mode: .previewCharacterWindow, characterChatProvider: provider)
        do {
            _ = try await coordinator.replyToCharacterChat("请帮我规划合成书房标签配色", history: [])
            XCTFail("Preview must reject an online question")
        } catch { XCTAssertTrue(error.localizedDescription.contains("离线预览")) }
    }

    func testVoiceReplyReusesOfflineCharacterPolicyAndKeepsVoiceMemoryProvenance() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()), mode: .previewCharacterWindow)
        let reply = try await coordinator.replyToCharacterChat("记住：合成语音偏好是安静的书房", history: [], memorySource: "用户语音明确指令")
        XCTAssertTrue(reply.contains("保存在本机"))
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let records = try await store.listMemories()
        XCTAssertEqual(records.first?.source, "用户语音明确指令")
        XCTAssertEqual(records.first?.status, .confirmed)
        let recalled = try await coordinator.replyToCharacterChat("你记得什么", history: [], memorySource: "用户语音明确指令")
        XCTAssertTrue(recalled.contains("安静的书房"))
        XCTAssertNotNil(SpeechReplyText.prepare(recalled))
    }

    func testOfflineGoalsKnowledgeImportReviewExpiryAndRestartWithoutProvider() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let runtime = Runtime(resources: root, state: root, configuration: .init())
        let coordinator = Coordinator(runtime: runtime, mode: .previewCharacterWindow)
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let goal = CharacterGoal(title: "整理合成书房", steps: [.init(text: "分类", isComplete: true), .init(text: "贴标签")])
        try await store.saveGoal(goal)
        _ = try await store.importKnowledge(text: "合成书房标签写分类", source: "合成手册")
        let candidates = try await store.listMemories()
        let item = try XCTUnwrap(candidates.first)
        let beforeConfirm = try await coordinator.replyToCharacterChat("你知道哪些角色知识", history: [])
        XCTAssertFalse(beforeConfirm.contains(item.text))
        try await store.confirmMemory(id: item.id)
        let expired = CharacterMemory(kind: .knowledge, text: "已失效的合成标签", source: "旧手册", status: .confirmed,
                                      expiresAt: .now.addingTimeInterval(-60))
        try await store.saveMemory(expired)
        let restarted = Coordinator(runtime: runtime, mode: .previewCharacterWindow)
        let progress = try await restarted.replyToCharacterChat("我们现在推进到哪一步了", history: [])
        XCTAssertTrue(progress.contains("1/2")); XCTAssertTrue(progress.contains("贴标签"))
        let knowledge = try await restarted.replyToCharacterChat("你知道哪些角色知识", history: [])
        XCTAssertTrue(knowledge.contains(item.text)); XCTAssertFalse(knowledge.contains(expired.text))
        let persistedGoals = try await store.listGoals()
        XCTAssertEqual(persistedGoals.first?.steps, goal.steps)
        XCTAssertFalse(try XCTUnwrap(persistedGoals.first).shareWithOnlineModel)
        let persistedMemories = try await store.listMemories()
        XCTAssertTrue(persistedMemories.allSatisfy { !$0.shareWithOnlineModel })
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("model-provider.json").path))
    }

    func testOfflinePreviewRememberReviewRecallAndRestartWithoutProviderSetup() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let runtime = Runtime(resources: root, state: root, configuration: .init())
        let coordinator = Coordinator(runtime: runtime, mode: .previewCharacterWindow)
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")

        let introduction = try await coordinator.replyToCharacterChat("你是谁", history: [])
        XCTAssertTrue(introduction.contains("龙妹"))
        let saved = try await coordinator.replyToCharacterChat("记住：验收偏好是喜欢安静的书房", history: [])
        XCTAssertTrue(saved.contains("已保存在本机"))
        let duplicate = try await coordinator.replyToCharacterChat("记住：验收偏好是喜欢安静的书房", history: [])
        XCTAssertTrue(duplicate.contains("没有重复保存"))
        let rejected = try await coordinator.replyToCharacterChat("记住：密码是 synthetic-not-a-secret", history: [])
        XCTAssertTrue(rejected.contains("不会保存"))
        let pending = try await coordinator.replyToCharacterChat("记住：用药验收样本，不是真实资料", history: [])
        XCTAssertTrue(pending.contains("确认"))

        let memories = try await store.listMemories()
        XCTAssertEqual(memories.count, 2)
        XCTAssertEqual(memories.filter { $0.status == .candidate }.count, 1)
        XCTAssertTrue(memories.allSatisfy { !$0.shareWithOnlineModel })

        let restarted = Coordinator(runtime: runtime, mode: .previewCharacterWindow)
        let recalled = try await restarted.replyToCharacterChat("你记得什么", history: [])
        XCTAssertTrue(recalled.contains("安静的书房"))
        XCTAssertFalse(recalled.contains("用药"))
        do {
            _ = try await restarted.replyToCharacterChat("普通问题需要模型回答", history: [])
            XCTFail("Offline preview must reject the online branch")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("离线预览"))
        }
        let capabilities = try await restarted.replyToCharacterChat("你会什么", history: [])
        XCTAssertTrue(capabilities.contains("在线对话会在需要时检查配置"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("model-provider.json").path))
    }
}
