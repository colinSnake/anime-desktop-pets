import CharacterCore
import CharacterMemory
import XCTest
@testable import CharacterUI

// Hold the real actor only in tests, so a queued store operation resumes after cancellation.
private extension CharacterMemoryStore {
    func waitAtReviewTestBarrier(started: XCTestExpectation, release: DispatchSemaphore) -> Bool {
        started.fulfill()
        return release.wait(timeout: .now() + 5) == .success
    }
}

@MainActor
final class CharacterReviewStorageTests: XCTestCase {
    private func suggestion(for turn: CharacterChatTurn, confidence: Double = 0.99) throws -> CharacterMemorySuggestion {
        let json = try JSONSerialization.data(withJSONObject: ["suggestions": [[
            "turnID": turn.id.uuidString, "kind": "preference", "quote": turn.text, "confidence": confidence
        ]]])
        return try XCTUnwrap(CharacterMemorySuggestion.parse(String(decoding: json, as: UTF8.self), turns: [turn]).first)
    }

    func testClearWhileReviewWaitsForStorageDoesNotWriteOldEvidence() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "review-storage-cancellation")
        var reply: CheckedContinuation<[CharacterMemorySuggestion], Error>?
        var evidence: [CharacterChatTurn] = []
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in "合成回复" },
            reviewMemories: { turns, _ in
                evidence = turns
                return try await withCheckedThrowingContinuation { reply = $0 }
            })
        for _ in 0..<200 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        for _ in 0..<200 where model.automaticReviewStatus.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        for index in 1...3 {
            model.sendChat("存储等待期原话 \(index)")
            for _ in 0..<200 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        }
        let oldTask = try XCTUnwrap(model.automaticReviewTask)
        let turn = try XCTUnwrap(evidence.first)
        let candidate = try suggestion(for: turn)
        let started = expectation(description: "real memory actor held")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let blocker = Task.detached { await store.waitAtReviewTestBarrier(started: started, release: release) }
        await fulfillment(of: [started], timeout: 2)
        try XCTUnwrap(reply).resume(returning: [candidate])
        // The provider has returned; the old task is now queued on the held actor.
        for _ in 0..<20 { await Task.yield() }
        model.clearChat()
        release.signal()
        let releasedInTime = await blocker.value
        XCTAssertTrue(releasedInTime)
        await oldTask.value
        let saved = try await store.listMemories()
        XCTAssertTrue(saved.isEmpty, "已取消的存储等待任务不得落库旧建议")
        XCTAssertTrue(model.memories.isEmpty)
    }

    func testAtomicReviewChecksCancellationBeforeWritingAndSerializesDuplicateDecisions() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "atomic-review")
        let turn = CharacterChatTurn(role: .user, text: "我喜欢合成乌龙茶")
        let first = try suggestion(for: turn)
        let second = try suggestion(for: turn)
        let cancelled = Task { () throws -> CharacterMemoryReview.AutomationDecision in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await store.applyAutomaticReview(first)
        }
        do { _ = try await cancelled.value; XCTFail("已取消任务不得写入") } catch is CancellationError {}
        async let a = store.applyAutomaticReview(first)
        async let b = store.applyAutomaticReview(second)
        _ = try await (a, b)
        let saved = try await store.listMemories()
        XCTAssertEqual(saved.count, 1, "判定和落库必须在同一 actor 操作内完成，不能并发创建重复记录")
        XCTAssertEqual(saved.first?.status, .confirmed)
        XCTAssertEqual(saved.first?.shareWithOnlineModel, false)
    }
}
