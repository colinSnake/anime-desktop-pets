import CharacterCore
import CharacterMemory
import Foundation
import XCTest

final class CharacterAdaptationConcurrencyTests: XCTestCase {
    func testSeparateStoreLearnerCannotOverwritePersistedSharingRevocation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let revoker = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
        var initial = CharacterAdaptationState()
        initial.shareWithOnlineModel = true
        try await revoker.saveAdaptation(initial)
        let ready = expectation(description: "Learner reached its save")
        let release = DispatchSemaphore(value: 0)
        let manager = AdaptationGatedFileManager(ready: { ready.fulfill() }, release: release)
        let learner = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic", fileManager: manager)
        let learning = Task.detached { try await learner.observeAdaptation(.init(role: .user, text: "请活泼一点")) }
        await fulfillment(of: [ready], timeout: 3)
        let revocation = Task.detached {
            defer { release.signal() }
            return try await revoker.applyAdaptationOperation(.sharing(false))
        }
        _ = try await revocation.value
        _ = try await learning.value
        let saved = try await revoker.loadAdaptation()
        XCTAssertFalse(saved.shareWithOnlineModel, "A different actor's stale learning must never restore consent")
        XCTAssertEqual(saved.playfulness, 1)
    }

    func testSynchronousDenyCoversLoadedSnapshotsOtherActorsAndContextBeforeSaving() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
        let other = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
        var initial = CharacterAdaptationState()
        _ = initial.observe(.init(role: .user, text: "请简短一点"))
        initial.shareWithOnlineModel = true
        try await store.saveAdaptation(initial)
        var snapshot = try await other.loadAdaptation()
        XCTAssertFalse(snapshot.promptText.isEmpty)
        let oldEpoch = other.adaptationEpoch
        let sharingEpoch = store.beginAdaptationOperation(.sharing(false))
        XCTAssertNotEqual(oldEpoch, other.adaptationEpoch)
        XCTAssertEqual(snapshot.promptText, "")
        XCTAssertNil(CharacterContextBuilder.make(identity: nil, memories: [], adaptation: snapshot, query: "合成问题"))
        let denied = try await other.loadAdaptation()
        XCTAssertFalse(denied.shareWithOnlineModel)
        XCTAssertTrue(denied.enabled, "Sharing revocation alone does not disable local learning")
        let late = try await other.observeAdaptation(.init(role: .user, text: "请活泼一点"), epoch: oldEpoch)
        XCTAssertEqual(late.playfulness, 0)
        _ = try await store.applyAdaptationOperation(.sharing(false), epoch: sharingEpoch)
        let enabledEpoch = store.beginAdaptationOperation(.enabled(false))
        XCTAssertFalse(snapshot.observe(.init(role: .user, text: "请活泼一点")))
        let disabled = try await other.observeAdaptation(.init(role: .user, text: "请活泼一点"))
        XCTAssertFalse(disabled.enabled)
        XCTAssertEqual(disabled.playfulness, 0)
        _ = try await store.applyAdaptationOperation(.enabled(false), epoch: enabledEpoch)
    }

    func testPlainSaveFeedbackAndUnrelatedGrantCannotClearSharingDeny() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
        var initial = CharacterAdaptationState()
        _ = initial.observe(.init(role: .user, text: "请简短一点"))
        initial.shareWithOnlineModel = true
        try await store.saveAdaptation(initial)
        _ = store.beginAdaptationOperation(.sharing(false))
        try await store.saveAdaptation(initial)
        let learned = try await store.observeAdaptation(.init(role: .user, text: "请活泼一点"))
        XCTAssertEqual(learned.playfulness, 1)
        XCTAssertFalse(learned.shareWithOnlineModel)
        let unrelated = try await store.applyAdaptationOperation(.enabled(true))
        XCTAssertFalse(unrelated.shareWithOnlineModel)
        let granted = try await store.applyAdaptationOperation(.sharing(true))
        XCTAssertTrue(granted.shareWithOnlineModel)
        XCTAssertFalse(granted.promptText.isEmpty)
    }

    func testNewestSamePermissionIntentWinsEvenWhenActorsApplyOutOfOrder() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
        let second = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
        for grantLast in [false, true] {
            let oldOperation: CharacterAdaptationOperation = .sharing(!grantLast)
            let newOperation: CharacterAdaptationOperation = .sharing(grantLast)
            let oldEpoch = first.beginAdaptationOperation(oldOperation)
            let newEpoch = second.beginAdaptationOperation(newOperation)
            _ = try await second.applyAdaptationOperation(newOperation, epoch: newEpoch)
            let stale = try await first.applyAdaptationOperation(oldOperation, epoch: oldEpoch)
            XCTAssertEqual(stale.shareWithOnlineModel, grantLast)
        }
    }

    func testResetRollbackAndAuthorizationChangesRejectOldSpeechStyleLearningEpochs() async throws {
        for operation: CharacterAdaptationOperation in [.reset, .rollback, .enabled(false), .sharing(false)] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let ui = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
            let voice = try CharacterMemoryStore(stateDirectory: root, petID: "synthetic")
            _ = try await ui.observeAdaptation(.init(role: .user, text: "请简短一点"))
            let requestEpoch = voice.adaptationEpoch
            _ = try await ui.applyAdaptationOperation(operation)
            let before = try await ui.loadAdaptation()
            let late = try await voice.observeAdaptation(.init(role: .user, text: "请活泼一点"), epoch: requestEpoch)
            XCTAssertEqual(late, before)
            let disk = try await ui.loadAdaptation()
            XCTAssertEqual(disk, before)
        }
    }

    func testSessionDenyIsPerCharacterAndSurvivesRecreatingItsStore() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try CharacterMemoryStore(stateDirectory: root, petID: "first")
        _ = first.beginAdaptationOperation(.enabled(false))
        let reopened = try CharacterMemoryStore(stateDirectory: root.appendingPathComponent("."), petID: "first")
        let second = try CharacterMemoryStore(stateDirectory: root, petID: "second")
        let denied = try await reopened.loadAdaptation()
        let unaffected = try await second.loadAdaptation()
        XCTAssertFalse(denied.enabled)
        XCTAssertTrue(unaffected.enabled)
        XCTAssertEqual(first.adaptationEpoch, reopened.adaptationEpoch)
    }

}

/// With the old implementation the revoker completes while the learner has stale data.
/// A serialized implementation instead waits for this bounded gate, then revokes last.
private final class AdaptationGatedFileManager: FileManager, @unchecked Sendable {
    private let ready: () -> Void
    private let release: DispatchSemaphore
    private var visits = 0

    init(ready: @escaping () -> Void, release: DispatchSemaphore) {
        self.ready = ready
        self.release = release
        super.init()
    }

    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        if path.hasSuffix("/plans") {
            visits += 1
            if visits == 2 {
                ready()
                _ = release.wait(timeout: .now() + 0.3)
            }
        }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
}
