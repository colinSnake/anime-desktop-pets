import CharacterCore
import CharacterMemory
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterChatRequestTests: XCTestCase {
    private func fixture(chat: @escaping (String, [CharacterChatTurn], CharacterChatModelSelection?) async throws -> String,
                         review: (([CharacterChatTurn], CharacterChatModelSelection?) async throws -> [CharacterMemorySuggestion])? = nil) throws -> (URL, CharacterWorkspaceModel) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic-chat-request")
        return (directory, CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: chat,
                                                   reviewMemories: review))
    }

    private func idle(_ model: CharacterWorkspaceModel) async throws {
        for _ in 0..<200 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertFalse(model.isChatSending)
    }

    func testLongReplyRemainsCompleteWhileOutboundHistoryIsBounded() async throws {
        let reply = String(repeating: "完整答复", count: 2_000)
        var history: [CharacterChatTurn] = []
        let (dir, model) = try fixture { _, turns, _ in history = turns; return reply }
        defer { try? FileManager.default.removeItem(at: dir) }
        model.sendChat("合成问题")
        try await idle(model)
        XCTAssertEqual(model.chatTurns.last?.text, reply)
        model.sendChat("下一条问题")
        try await idle(model)
        XCTAssertLessThanOrEqual(history.reduce(0) { $0 + $1.text.count }, CharacterChatSession.maxCharacters)
        XCTAssertTrue(history.allSatisfy { $0.text.count <= CharacterChatSession.maxTextCharacters })
    }
}

extension CharacterChatRequestTests {
    func testDisabledAutomaticReviewNeverCallsProvider() async throws {
        var reviewCalls = 0
        let (dir, model) = try fixture(chat: { _, _, _ in "回复" }, review: { _, _ in
            reviewCalls += 1
            return []
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertFalse(model.automaticReviewEnabled)
        for index in 1...3 {
            model.sendChat("默认关闭 \(index)")
            try await idle(model)
        }
        XCTAssertEqual(reviewCalls, 0)
    }

    func testFailedAutomaticReviewWaitsForNextSuccessfulReplyBeforeRetrying() async throws {
        var reviewCalls = 0
        let (dir, model) = try fixture(chat: { _, _, _ in "回复" }, review: { _, _ in
            reviewCalls += 1
            try await Task.sleep(nanoseconds: 2_000_000)
            throw URLError(.timedOut)
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        try await Task.sleep(nanoseconds: 20_000_000)
        for index in 1...3 {
            model.sendChat("失败后等待下轮 \(index)")
            try await idle(model)
        }
        for _ in 0..<200 where reviewCalls == 0 { try await Task.sleep(nanoseconds: 1_000_000) }
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(reviewCalls, 1, "同一批失败后不得立即循环重试")
        model.sendChat("新答复完成后才重试")
        try await idle(model)
        for _ in 0..<200 where reviewCalls < 2 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(reviewCalls, 2)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(reviewCalls, 2, "下一次失败也只能等后续成功答复")
    }

    func testClearingChatDiscardsPendingReviewAndRestartsThreeTurnThreshold() async throws {
        var batches: [[CharacterChatTurn]] = []
        var continuations: [CheckedContinuation<[CharacterMemorySuggestion], Error>] = []
        let (dir, model) = try fixture(chat: { _, _, _ in "本地合成回复" }, review: { turns, _ in
            batches.append(turns)
            return try await withCheckedThrowingContinuation { continuations.append($0) }
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        for _ in 0..<200 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        for index in 1...3 {
            model.sendChat("清空前偏好 \(index)")
            try await idle(model)
        }
        for _ in 0..<200 where batches.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        let oldTurn = try XCTUnwrap(batches.first?.first)
        let json = try JSONSerialization.data(withJSONObject: ["suggestions": [[
            "turnID": oldTurn.id.uuidString, "kind": "preference", "quote": oldTurn.text, "confidence": 0.99
        ]]])
        let late = try CharacterMemorySuggestion.parse(String(decoding: json, as: UTF8.self), turns: [oldTurn])
        model.clearChat()
        continuations[0].resume(returning: late)
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(model.memories.isEmpty, "清空聊天必须丢弃旧批次的迟到建议")
        for index in 1...2 {
            model.sendChat("清空后偏好 \(index)")
            try await idle(model)
        }
        XCTAssertEqual(batches.count, 1, "清空后不能沿用旧阈值")
        model.sendChat("清空后偏好 3")
        try await idle(model)
        for _ in 0..<200 where batches.count < 2 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(batches.last?.map(\.text), ["清空后偏好 1", "清空后偏好 2", "清空后偏好 3"])
        if continuations.count > 1 { continuations[1].resume(returning: []) }
    }

    func testProviderCancellationReleasesReviewSlotWithoutImmediateRetry() async throws {
        var calls = 0
        let (dir, model) = try fixture(chat: { _, _, _ in "合成回复" }, review: { _, _ in
            calls += 1
            throw CancellationError()
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        for _ in 0..<200 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        for index in 1...3 {
            model.sendChat("主动取消测试 \(index)")
            try await idle(model)
        }
        for _ in 0..<200 where calls == 0 { try await Task.sleep(nanoseconds: 1_000_000) }
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(calls, 1)
        model.sendChat("新的成功答复")
        try await idle(model)
        for _ in 0..<200 where calls < 2 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(calls, 2, "提供器主动取消后不能永久占用进行中名额")
    }

    func testOldReviewCannotClearNewReviewSlotAfterDisableAndReenable() async throws {
        var continuations: [CheckedContinuation<[CharacterMemorySuggestion], Error>] = []
        let (dir, model) = try fixture(chat: { _, _, _ in "合成答复" }, review: { _, _ in
            try await withCheckedThrowingContinuation { continuations.append($0) }
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        for _ in 0..<200 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        for index in 1...3 {
            model.sendChat("旧批次 \(index)")
            try await idle(model)
        }
        for _ in 0..<200 where continuations.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        model.setAutomaticReviewEnabled(false)
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        for index in 1...3 {
            model.sendChat("新批次 \(index)")
            try await idle(model)
        }
        for _ in 0..<200 where continuations.count < 2 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(continuations.count, 2)
        guard continuations.count >= 2 else {
            continuations.first?.resume(returning: [])
            return
        }
        continuations[0].resume(returning: [])
        try await Task.sleep(nanoseconds: 10_000_000)
        for index in 1...3 {
            model.sendChat("下一批排队 \(index)")
            try await idle(model)
        }
        XCTAssertEqual(continuations.count, 2, "旧回调不能释放正在运行的新审核名额")
        continuations[1].resume(returning: [])
        for _ in 0..<200 where continuations.count < 3 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(continuations.count, 3)
        for continuation in continuations.dropFirst(2) { continuation.resume(returning: []) }
    }

    func testDisablingReviewDropsLateSuggestions() async throws {
        var continuation: CheckedContinuation<[CharacterMemorySuggestion], Error>?
        var lateSuggestions: [CharacterMemorySuggestion] = []
        let (dir, model) = try fixture(chat: { _, _, _ in "回复" }, review: { turns, _ in
            let turn = try XCTUnwrap(turns.first)
            let json = try JSONSerialization.data(withJSONObject: ["suggestions": [[
                "turnID": turn.id.uuidString, "kind": "fact", "quote": turn.text, "confidence": 0.99
            ]]])
            lateSuggestions = try CharacterMemorySuggestion.parse(String(decoding: json, as: UTF8.self), turns: turns)
            return try await withCheckedThrowingContinuation { continuation = $0 }
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        try await Task.sleep(nanoseconds: 20_000_000)
        for index in 1...3 {
            model.sendChat("关闭时不应保存 \(index)")
            try await idle(model)
        }
        for _ in 0..<200 where continuation == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        model.setAutomaticReviewEnabled(false)
        continuation?.resume(returning: lateSuggestions)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(model.memories.isEmpty)
    }

    func testAutomaticReviewRunsAfterThreeSuccessfulUserTurnsAndAutoConfirmsEvidence() async throws {
        var reviewed: [[CharacterChatTurn]] = []
        let (dir, model) = try fixture(chat: { _, _, _ in "回复" }, review: { turns, _ in
            reviewed.append(turns)
            let turn = try XCTUnwrap(turns.first)
            let json = try JSONSerialization.data(withJSONObject: ["suggestions": [[
                "turnID": turn.id.uuidString, "kind": "preference", "quote": turn.text, "confidence": 0.98
            ]]])
            return try CharacterMemorySuggestion.parse(String(decoding: json, as: UTF8.self), turns: turns)
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        try await Task.sleep(nanoseconds: 20_000_000)
        for index in 1...2 {
            model.sendChat("合成偏好 \(index)")
            try await idle(model)
        }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(reviewed.isEmpty)
        model.sendChat("合成偏好 3")
        try await idle(model)
        for _ in 0..<200 where reviewed.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(reviewed.first?.map(\.text), ["合成偏好 1", "合成偏好 2", "合成偏好 3"])
        for _ in 0..<200 where model.memories.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        let saved = try XCTUnwrap(model.memories.first)
        XCTAssertEqual(saved.status, .confirmed)
        XCTAssertFalse(saved.shareWithOnlineModel)
    }

    func testSuccessfulLocalAnswersAlsoCountTowardAutomaticReviewBatch() async throws {
        let identity = CharacterIdentity.starter(name: "合成桌宠")
        var reviewed: [[CharacterChatTurn]] = []
        let (dir, model) = try fixture(chat: { text, _, _ in
            try XCTUnwrap(CharacterLocalAnswer.answer(for: text, identity: identity, memories: [], capabilities: []))
        }, review: { turns, _ in
            reviewed.append(turns)
            return []
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        try await Task.sleep(nanoseconds: 20_000_000)
        for _ in 1...3 {
            model.sendChat("你是谁")
            try await idle(model)
        }
        for _ in 0..<200 where reviewed.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(reviewed.first?.map(\.role), [.user, .user, .user])
        XCTAssertEqual(model.chatTurns.filter { $0.role == .assistant }.count, 3)
    }

    func testAutomaticReviewKeepsRepliesUnblockedAndQueuesAtMostSixTurnsSerially() async throws {
        var batches: [[CharacterChatTurn]] = []
        var continuations: [CheckedContinuation<[CharacterMemorySuggestion], Error>] = []
        let (dir, model) = try fixture(chat: { _, _, _ in "即时合成回复" }, review: { turns, _ in
            batches.append(turns)
            return try await withCheckedThrowingContinuation { continuations.append($0) }
        })
        defer { try? FileManager.default.removeItem(at: dir) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        try await Task.sleep(nanoseconds: 20_000_000)

        for index in 1...3 {
            model.sendChat("首批发言 \(index)")
            try await idle(model)
        }
        for _ in 0..<200 where continuations.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(batches.first?.count, 3)
        XCTAssertFalse(model.isChatSending, "审核请求不能阻塞已经完成的聊天回复")

        for index in 1...9 {
            model.sendChat("排队发言 \(index)")
            try await idle(model)
        }
        XCTAssertEqual(continuations.count, 1, "第一批未结束时不能并发发起第二个审核请求")
        continuations[0].resume(returning: [])
        for _ in 0..<200 where continuations.count < 2 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(batches.count, 2)
        XCTAssertEqual(batches[1].count, 6)
        XCTAssertEqual(batches[1].map(\.text), ["排队发言 4", "排队发言 5", "排队发言 6", "排队发言 7", "排队发言 8", "排队发言 9"])
        XCTAssertTrue(batches[1].allSatisfy { $0.role == .user })
        continuations[1].resume(returning: [])
    }
}

extension CharacterChatRequestTests {
    func testCancelIgnoresLateReplyAndCannotFinishANewerRequest() async throws {
        var continuations: [CheckedContinuation<String, Error>] = []
        let (dir, model) = try fixture { _, _, _ in
            try await withCheckedThrowingContinuation { continuations.append($0) }
        }
        defer { try? FileManager.default.removeItem(at: dir) }
        model.chatDraft = "第一条问题"
        model.sendDraft()
        while continuations.isEmpty { await Task.yield() }
        model.cancelChat()
        XCTAssertFalse(model.isChatSending)
        XCTAssertEqual(model.chatDraft, "第一条问题")
        model.chatDraft = "第二条问题"
        model.sendDraft()
        while continuations.count < 2 { await Task.yield() }
        continuations[0].resume(returning: "不应出现的旧回复")
        try await Task.sleep(nanoseconds: 5_000_000)
        XCTAssertTrue(model.isChatSending)
        XCTAssertFalse(model.chatTurns.contains { $0.text == "不应出现的旧回复" })
        continuations[1].resume(returning: "新回复")
        try await idle(model)
        XCTAssertEqual(model.chatTurns.last?.text, "新回复")
    }

    func testRetryKeepsUserIdentityHistoryAndNewDraft() async throws {
        var calls = 0
        var histories: [[CharacterChatTurn]] = []
        let (dir, model) = try fixture { _, history, _ in
            histories.append(history)
            calls += 1
            if calls == 1 { throw URLError(.timedOut) }
            return "成功答复"
        }
        defer { try? FileManager.default.removeItem(at: dir) }
        model.chatDraft = "需要重试的问题"
        model.sendDraft()
        try await idle(model)
        let id = try XCTUnwrap(model.chatTurns.last?.id)
        XCTAssertEqual(model.chatDraft, "需要重试的问题")
        model.chatDraft = "尚未发送的新草稿"
        model.retryFailedChat()
        try await idle(model)
        XCTAssertEqual(model.chatTurns.first?.id, id)
        XCTAssertEqual(histories, [[], []])
        XCTAssertEqual(model.chatDraft, "尚未发送的新草稿")
        XCTAssertEqual(model.chatTurns.filter { $0.role == .user }.count, 1)
    }

    func testEmptyReplyFailsAndSendingRestoredDraftRetriesSameTurn() async throws {
        var count = 0
        let (dir, model) = try fixture { _, _, _ in count += 1; return count == 1 ? "  \n " : "重新答复" }
        defer { try? FileManager.default.removeItem(at: dir) }
        model.chatDraft = "合成问题"
        model.sendDraft()
        try await idle(model)
        XCTAssertEqual(model.failedChatText, "合成问题")
        XCTAssertFalse(model.chatStatus.isEmpty)
        let id = model.chatTurns.first?.id
        model.sendDraft()
        try await idle(model)
        XCTAssertEqual(count, 2)
        XCTAssertEqual(model.chatTurns.count, 2)
        XCTAssertEqual(model.chatTurns.first?.id, id)
    }

    func testClearingChatKeepsDraftAndLongTermMemory() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "synthetic-clear")
        try await store.saveMemory(CharacterMemory(kind: .fact, text: "明确保存的合成资料", source: "合成测试", status: .confirmed))
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in "普通合成回复" })
        model.sendChat("普通问题")
        try await idle(model)
        model.chatDraft = "未发送草稿"
        model.clearChat()
        XCTAssertTrue(model.chatTurns.isEmpty)
        XCTAssertEqual(model.chatDraft, "未发送草稿")
        let memories = try await store.listMemories()
        XCTAssertEqual(memories.map(\.text), ["明确保存的合成资料"])
    }
}
