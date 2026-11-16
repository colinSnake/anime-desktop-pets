import CharacterCore
import CharacterMemory
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterAdaptationWorkspaceTests: XCTestCase {
    func testSuccessfulFeedbackLearnsLocallyAndCanRollbackWithoutChangingIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in "收到。" })
        model.sendChat("以后请回答简短一点。")
        for _ in 0..<500 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        await model.adaptationTask?.value
        let saved = try await store.loadAdaptation()
        XCTAssertLessThan(saved.verbosity, 0)
        XCTAssertEqual(saved.promptText, "")
        XCTAssertEqual(model.identity.name, "合成角色")
        model.rollbackAdaptation()
        await model.adaptationTask?.value
        XCTAssertEqual(model.adaptation.verbosity, 0)
    }

    func testSharingAndDisableAreSerializedAndRefreshCannotRestoreStaleConsent() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        model.setAdaptationSharing(true)
        model.setAdaptationSharing(false)
        model.setAdaptationEnabled(false)
        model.refresh()
        await model.adaptationTask?.value
        XCTAssertFalse(model.adaptation.enabled)
        XCTAssertFalse(model.adaptation.shareWithOnlineModel)
        let saved = try await store.loadAdaptation()
        XCTAssertFalse(saved.enabled)
        XCTAssertFalse(saved.shareWithOnlineModel)
    }

    func testFailedRevocationRemainsDeniedForContextLearningAndUI() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let manager = AdaptationFailingFileManager()
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic", fileManager: manager)
        var initial = CharacterAdaptationState()
        _ = initial.observe(.init(role: .user, text: "请简短一点"))
        initial.shareWithOnlineModel = true
        try await store.saveAdaptation(initial)
        var sentAdaptation = false
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { text, _, _ in
            let loaded = try await store.loadAdaptation()
            sentAdaptation = CharacterContextBuilder.make(identity: nil, memories: [], adaptation: loaded, query: text) != nil
            return "收到。"
        })
        for _ in 0..<500 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(model.canSaveIdentity)
        manager.failNext = true
        model.setAdaptationSharing(false)
        await model.adaptationTask?.value
        XCTAssertFalse(model.adaptation.shareWithOnlineModel)
        model.sendChat("请活泼一点")
        for _ in 0..<500 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertFalse(model.isChatSending)
        XCTAssertFalse(sentAdaptation)
        XCTAssertFalse(model.adaptation.enabled)
        XCTAssertFalse(model.adaptation.shareWithOnlineModel)
        XCTAssertEqual(model.adaptation.playfulness, 0)
        XCTAssertTrue(model.adaptationStatus.contains("未保存"), "A later successful chat must not hide the save failure")
    }

    func testResetBetweenServiceObservationAndUICompletionCannotReapplyFeedback() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        var model: CharacterWorkspaceModel!
        model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { text, _, _ in
            _ = try await store.observeAdaptation(.init(role: .user, text: text))
            model.resetAdaptation()
            await model.adaptationTask?.value
            return "收到。"
        })
        model.sendChat("请简短一点")
        for _ in 0..<500 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertFalse(model.isChatSending)
        let saved = try await store.loadAdaptation()
        XCTAssertEqual(saved.verbosity, 0)
        XCTAssertEqual(saved.history.map(\.kind), [.feedback, .reset])
    }

    func testRevokeImmediatelyGuardsAlreadyLoadedContextBeforeQueuedSave() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        var initial = CharacterAdaptationState()
        _ = initial.observe(.init(role: .user, text: "请简短一点"))
        initial.shareWithOnlineModel = true
        try await store.saveAdaptation(initial)
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        for _ in 0..<500 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        let snapshot = try await store.loadAdaptation()
        XCTAssertFalse(snapshot.promptText.isEmpty)
        model.setAdaptationSharing(false)
        // No await: the queued save cannot have run yet.
        XCTAssertEqual(snapshot.promptText, "")
        XCTAssertNil(CharacterContextBuilder.make(identity: nil, memories: [], adaptation: snapshot, query: "合成问题"))
        await model.adaptationTask?.value
    }

    func testDisableThenReenableWhileReplyIsPendingDoesNotLearnOldFeedback() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        var reply: CheckedContinuation<String, Never>?
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in
            await withCheckedContinuation { reply = $0 }
        })
        model.sendChat("请活泼一点")
        for _ in 0..<500 where reply == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        guard let reply else { return XCTFail("Chat did not start") }
        model.setAdaptationEnabled(false)
        model.setAdaptationEnabled(true)
        await model.adaptationTask?.value
        reply.resume(returning: "收到。")
        for _ in 0..<500 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertFalse(model.isChatSending)
        let saved = try await store.loadAdaptation()
        XCTAssertTrue(saved.enabled)
        XCTAssertEqual(saved.playfulness, 0)
        XCTAssertEqual(saved.revision, 0)
    }

    func testRetryAfterResetDoesNotReconsiderOldTurnButFreshTurnCanLearn() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        var attempts = 0
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in
            attempts += 1
            if attempts == 1 { throw URLError(.timedOut) }
            return "收到。"
        })
        model.sendChat("请活泼一点")
        for _ in 0..<500 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertNotNil(model.failedChatAttempt)
        model.resetAdaptation()
        await model.adaptationTask?.value
        model.retryFailedChat()
        for _ in 0..<500 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(model.adaptation.playfulness, 0)
        model.sendChat("请活泼一点")
        for _ in 0..<500 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertFalse(model.isChatSending)
        XCTAssertEqual(model.adaptation.playfulness, 1)
        let userTurn = try XCTUnwrap(model.chatTurns.last(where: { $0.role == .user }))
        XCTAssertEqual(model.adaptation.history.last?.evidence?.turnID, userTurn.id)
        XCTAssertEqual(model.adaptation.history.last?.evidence?.createdAt, userTurn.createdAt)
        XCTAssertEqual(model.adaptation.history.map(\.kind), [.reset, .feedback])
    }

    func testFailedRevocationIsSharedAcrossReopenedWindowsAndRequiresExplicitGrants() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let manager = AdaptationFailingFileManager()
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic", fileManager: manager)
        var initial = CharacterAdaptationState()
        _ = initial.observe(.init(role: .user, text: "请简短一点"))
        initial.shareWithOnlineModel = true
        try await store.saveAdaptation(initial)
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        for _ in 0..<500 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        manager.failNext = true
        model.setAdaptationEnabled(false)
        await model.adaptationTask?.value
        let reopenedStore = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic")
        let reopened = CharacterWorkspaceModel(store: reopenedStore, defaultName: "合成角色")
        for _ in 0..<500 where !reopened.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertFalse(reopened.adaptation.enabled)
        XCTAssertFalse(reopened.adaptation.shareWithOnlineModel)
        XCTAssertTrue(reopened.adaptationStatus.contains("未保存"))
        try await reopenedStore.saveAdaptation(initial)
        let stillDenied = try await reopenedStore.loadAdaptation()
        XCTAssertFalse(stillDenied.enabled)
        XCTAssertFalse(stillDenied.shareWithOnlineModel)
        reopened.setAdaptationEnabled(true)
        await reopened.adaptationTask?.value
        XCTAssertTrue(reopened.adaptation.enabled)
        XCTAssertFalse(reopened.adaptation.shareWithOnlineModel)
        XCTAssertTrue(reopened.adaptationStatus.contains("未保存"))
        reopened.setAdaptationSharing(true)
        await reopened.adaptationTask?.value
        XCTAssertTrue(reopened.adaptation.shareWithOnlineModel)
        XCTAssertFalse(reopened.adaptation.promptText.isEmpty)
        XCTAssertFalse(reopened.adaptationStatus.contains("未保存"))
        reopened.setAdaptationSharing(false)
        await reopened.adaptationTask?.value
        XCTAssertFalse(reopened.adaptationStatus.contains("未保存"), "A resolved failure must not reappear on a later successful revoke")
    }
}

private final class AdaptationFailingFileManager: FileManager, @unchecked Sendable {
    var failNext = false
    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        if failNext {
            failNext = false
            throw CocoaError(.fileWriteNoPermission)
        }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
}
