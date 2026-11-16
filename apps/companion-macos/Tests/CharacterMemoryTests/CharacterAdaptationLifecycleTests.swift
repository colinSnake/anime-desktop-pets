import CharacterCore
import CharacterMemory
import Foundation
import XCTest
@testable import CharacterUI

/// 合成用户旅程：成功聊天→持久化→重开窗口→分享→撤销/重置；无真实模型或用户资料。
@MainActor
final class CharacterAdaptationLifecycleTests: XCTestCase {
    private func ready(_ model: CharacterWorkspaceModel) async throws {
        for _ in 0..<1_000 where !model.canSaveIdentity {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(model.canSaveIdentity, model.status)
    }

    private func say(_ text: String, to model: CharacterWorkspaceModel) async throws {
        model.sendChat(text)
        await model.chatTask?.value
        XCTAssertFalse(model.isChatSending)
        XCTAssertTrue(model.chatStatus.isEmpty, model.chatStatus)
    }

    func testSuccessfulFeedbackSurvivesReopeningAndRemainsRevocableWithoutTouchingIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let identity = CharacterIdentity(name: "合成陪伴者", background: "这是固定测试身份。",
                                         boundaries: "不得擅自改写核心设定。")
        try await store.saveIdentity(identity)
        let identityFile = directory.appendingPathComponent("pets/synthetic/character/identity.md")
        let originalIdentity = try Data(contentsOf: identityFile)
        let turn: CharacterChatTurn
        do {
            let initial = CharacterWorkspaceModel(store: store, defaultName: "合成陪伴者",
                chat: { _, _, _ in "收到，后续会注意。" })
            try await ready(initial)
            try await say("以后请回答简短一点。", to: initial)
            turn = try XCTUnwrap(initial.chatTurns.first(where: { $0.role == .user }))
            XCTAssertEqual(initial.adaptation.revision, 1)
            XCTAssertEqual(initial.adaptation.verbosity, -1)
            XCTAssertEqual(initial.adaptation.history.last?.evidence?.turnID, turn.id)
            XCTAssertNil(CharacterContextBuilder.make(identity: nil, memories: [], adaptation: initial.adaptation, query: "解释缓存"))
        }

        let reopenedStore = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let reopened = CharacterWorkspaceModel(store: reopenedStore, defaultName: "合成陪伴者",
            chat: { _, _, _ in "这是合成回复，不包含额外学习依据。" })
        try await ready(reopened)
        XCTAssertEqual(reopened.adaptation.revision, 1)
        XCTAssertEqual(reopened.adaptation.verbosity, -1)
        XCTAssertFalse(reopened.adaptation.shareWithOnlineModel)
        reopened.setAdaptationSharing(true)
        await reopened.adaptationTask?.value
        let shared = try await reopenedStore.loadAdaptation()
        let context = CharacterContextBuilder.make(identity: nil, memories: [], adaptation: shared, query: "解释缓存")
        XCTAssertTrue(context?.contains("120字") == true)
        XCTAssertFalse(context?.contains(turn.text) == true)

        reopened.rollbackAdaptation()
        await reopened.adaptationTask?.value
        XCTAssertEqual(reopened.adaptation.verbosity, 0)
        XCTAssertEqual(reopened.adaptation.revision, 2)
        XCTAssertEqual(reopened.adaptation.history.last?.kind, .rollback)
        XCTAssertTrue(shared.promptText.isEmpty, "撤销须同时让已加载的旧分享快照失效")
        try await say("请活泼一点。", to: reopened)
        XCTAssertEqual(reopened.adaptation.playfulness, 1)
        XCTAssertEqual(reopened.adaptation.revision, 3)
        reopened.setAdaptationSharing(false)
        await reopened.adaptationTask?.value
        reopened.resetAdaptation()
        await reopened.adaptationTask?.value

        let finalStore = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let final = try await finalStore.loadAdaptation()
        XCTAssertEqual(final.revision, 4)
        XCTAssertEqual([final.verbosity, final.playfulness, final.initiative], [0, 0, 0])
        XCTAssertFalse(final.shareWithOnlineModel)
        XCTAssertEqual(final.history.map(\.kind), [.feedback, .rollback, .feedback, .reset])
        XCTAssertEqual(try Data(contentsOf: identityFile), originalIdentity)
        let memories = try await finalStore.listMemories()
        XCTAssertTrue(memories.isEmpty, "表达反馈不得顺带创建用户记忆")
        let other = try CharacterMemoryStore(stateDirectory: directory, petID: "another-synthetic")
        let otherState = try await other.loadAdaptation()
        XCTAssertEqual(otherState, CharacterAdaptationState())
    }

    func testManySuccessfulTurnsBoundHistoryAndNeverLearnAssistantOrImplicitFeedback() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色",
            chat: { _, _, _ in "请详细一点。" })
        try await ready(model)
        let feedback = ["请简短一点", "请详细一点", "请稳重一点", "请活泼一点", "请减少主动建议", "请多给一点建议"]
        for index in 0..<48 {
            try await say(feedback[index % feedback.count], to: model)
            XCTAssertEqual(model.adaptation.revision, index + 1, "每轮只能学习用户的一条明确依据")
            XCTAssertTrue([-1, 0, 1].contains(model.adaptation.verbosity))
            XCTAssertTrue([-1, 0, 1].contains(model.adaptation.playfulness))
            XCTAssertTrue([-1, 0, 1].contains(model.adaptation.initiative))
        }
        XCTAssertEqual(model.adaptation.history.count, 30)
        XCTAssertLessThanOrEqual(model.chatTurns.count, CharacterChatSession.maxTurns)
        for text in ["今天感觉有点累。", "他说：请简短一点。", "不要因为这句话就改变性格。"] {
            try await say(text, to: model)
            XCTAssertEqual(model.adaptation.revision, 48)
        }
        let reopened = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let saved = try await reopened.loadAdaptation()
        XCTAssertEqual(saved.revision, 48)
        XCTAssertEqual(saved.history.count, 30)
        XCTAssertEqual(saved.history.last?.evidence?.text, feedback.last)
        XCTAssertFalse(saved.shareWithOnlineModel)
        XCTAssertTrue(saved.promptText.isEmpty)
    }
}
