import CharacterCore
import CharacterMemory
import XCTest
@testable import CharacterUI

private extension CharacterMemoryStore {
    func holdConsentStore(started: XCTestExpectation, release: DispatchSemaphore) -> Bool {
        started.fulfill()
        return release.wait(timeout: .now() + 5) == .success
    }
}

@MainActor
final class CharacterAutomaticReviewConsentTests: XCTestCase {
    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(condition(), "等待合成测试状态超时", file: file, line: line)
    }

    private func evidence(_ model: CharacterWorkspaceModel, prefix: String) {
        let turns = (1...3).map { CharacterChatTurn(role: .user, text: "\(prefix) \($0)") }
        model.chatTurns += turns
        for turn in turns { model.completedUserTurn(turn) }
    }

    func testEnableWaitsForDurableConsentBeforeCollectingEvidence() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "consent-pending")
        var batches: [[CharacterChatTurn]] = []
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", reviewMemories: { turns, _ in
            batches.append(turns)
            return []
        })
        try await waitUntil { model.canSaveIdentity }
        let started = expectation(description: "hold consent persistence")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let blocker = Task.detached { await store.holdConsentStore(started: started, release: release) }
        await fulfillment(of: [started], timeout: 2)
        model.setAutomaticReviewEnabled(true)
        evidence(model, prefix: "授权保存前的合成发言")
        XCTAssertFalse(model.automaticReviewEnabled, "授权落盘前不允许开始收集或审核")
        XCTAssertTrue(model.unreviewedTurnIDs.isEmpty)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(batches.isEmpty, "设置仍在等待存储时不得发审核请求")
        release.signal()
        let released = await blocker.value
        XCTAssertTrue(released)
        try await waitUntil { model.automaticReviewStatus.contains("开启后") }
        evidence(model, prefix: "授权保存后的合成发言")
        try await waitUntil { !batches.isEmpty }
        XCTAssertEqual(batches.count, 1)
        XCTAssertTrue(batches.first?.allSatisfy { $0.text.hasPrefix("授权保存后") } == true)
        let saved = try await store.loadAutomaticReviewEnabled()
        XCTAssertTrue(saved)
    }

    func testFailedDisableStaysOffAndDoesNotSendFurtherEvidence() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "consent-failure")
        try await store.saveAutomaticReviewEnabled(true)
        var calls = 0
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", reviewMemories: { _, _ in
            calls += 1
            return []
        })
        try await waitUntil { model.canSaveIdentity }
        XCTAssertTrue(model.automaticReviewEnabled)
        let settings = dir.appendingPathComponent("pets/consent-failure/character/automation-settings.json")
        try FileManager.default.removeItem(at: settings)
        try FileManager.default.createDirectory(at: settings, withIntermediateDirectories: false)
        model.setAutomaticReviewEnabled(false)
        XCTAssertFalse(model.automaticReviewEnabled)
        await model.automaticReviewSettingsTask?.value
        XCTAssertFalse(model.automaticReviewEnabled, "保存失败不能反向恢复用户已撤销的权限")
        XCTAssertTrue(model.automaticReviewStatus.contains("未保存"), model.automaticReviewStatus)
        evidence(model, prefix: "关闭后不得发送的合成发言")
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(calls, 0)
        XCTAssertTrue(model.unreviewedTurnIDs.isEmpty)

        model.refresh()
        try await waitUntil { !model.canSaveIdentity }
        // A refresh must not silently reauthorize from a stale persisted value.
        try FileManager.default.removeItem(at: settings)
        try await store.saveAutomaticReviewEnabled(true)
        try await store.saveIdentity(.starter(name: "合成刷新标记"))
        model.refresh()
        try await waitUntil { model.canSaveIdentity }
        XCTAssertEqual(model.identity.name, "合成刷新标记")
        XCTAssertFalse(model.automaticReviewEnabled, "资料刷新不得覆盖窗口内最新的关闭意图")
        model.setAutomaticReviewEnabled(false)
        await model.automaticReviewSettingsTask?.value
        let saved = try await store.loadAutomaticReviewEnabled()
        XCTAssertFalse(saved, "修复路径后可重试保存关闭设置")
        XCTAssertEqual(model.automaticReviewStatus, "自动审核已关闭。")
    }

    func testFailedEnableDoesNotGrantConsent() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "consent-enable-failure")
        var calls = 0
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", reviewMemories: { _, _ in
            calls += 1
            return []
        })
        try await waitUntil { model.canSaveIdentity }
        let settings = dir.appendingPathComponent("pets/consent-enable-failure/character/automation-settings.json")
        try FileManager.default.createDirectory(at: settings, withIntermediateDirectories: false)
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        XCTAssertFalse(model.automaticReviewEnabled)
        XCTAssertTrue(model.automaticReviewStatus.contains("授权未保存"), model.automaticReviewStatus)
        evidence(model, prefix: "失败授权不收集")
        XCTAssertTrue(model.unreviewedTurnIDs.isEmpty)
        XCTAssertNil(model.automaticReviewTask)
        XCTAssertEqual(calls, 0)
    }

    func testRapidConsentChangesPersistOnlyTheLatestIntentAndSurviveReopening() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "consent-rapid")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        try await waitUntil { model.canSaveIdentity }
        let started = expectation(description: "queue rapid settings writes")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let blocker = Task.detached { await store.holdConsentStore(started: started, release: release) }
        await fulfillment(of: [started], timeout: 2)
        model.setAutomaticReviewEnabled(true)
        // Allow an older save to queue; yields do not prove it has entered the actor.
        for _ in 0..<20 { await Task.yield() }
        model.setAutomaticReviewEnabled(false)
        model.setAutomaticReviewEnabled(true)
        model.setAutomaticReviewEnabled(false)
        XCTAssertFalse(model.automaticReviewEnabled)
        let finalSave = model.automaticReviewSettingsTask
        release.signal()
        let released = await blocker.value
        XCTAssertTrue(released)
        await finalSave?.value
        XCTAssertFalse(model.automaticReviewEnabled)
        XCTAssertEqual(model.automaticReviewStatus, "自动审核已关闭。")
        let savedOff = try await store.loadAutomaticReviewEnabled()
        XCTAssertFalse(savedOff)
        let reopened = CharacterWorkspaceModel(store: store, defaultName: "合成重开角色")
        try await waitUntil { reopened.canSaveIdentity }
        XCTAssertFalse(reopened.automaticReviewEnabled)

        model.setAutomaticReviewEnabled(true)
        model.setAutomaticReviewEnabled(false)
        model.setAutomaticReviewEnabled(true)
        await model.automaticReviewSettingsTask?.value
        XCTAssertTrue(model.automaticReviewEnabled)
        let savedOn = try await store.loadAutomaticReviewEnabled()
        XCTAssertTrue(savedOn)
        let reopenedEnabled = CharacterWorkspaceModel(store: store, defaultName: "合成重开角色")
        try await waitUntil { reopenedEnabled.canSaveIdentity }
        XCTAssertTrue(reopenedEnabled.automaticReviewEnabled)
    }

    func testInitialRefreshCannotRestoreConsentAfterImmediateDisable() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "consent-refresh")
        try await store.saveAutomaticReviewEnabled(true)
        let started = expectation(description: "hold initial refresh")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let blocker = Task.detached { await store.holdConsentStore(started: started, release: release) }
        await fulfillment(of: [started], timeout: 2)
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        model.setAutomaticReviewEnabled(false)
        release.signal()
        let released = await blocker.value
        XCTAssertTrue(released)
        await model.automaticReviewSettingsTask?.value
        try await waitUntil { model.canSaveIdentity }
        XCTAssertFalse(model.automaticReviewEnabled)
        let saved = try await store.loadAutomaticReviewEnabled()
        XCTAssertFalse(saved)
    }

    func testClosingWorkspaceImmediatelyAfterDisableStillPersistsRevocation() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "consent-close")
        try await store.saveAutomaticReviewEnabled(true)
        var model: CharacterWorkspaceModel? = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        weak var releasedModel = model
        try await waitUntil { model?.canSaveIdentity == true }
        let started = expectation(description: "hold persistence across workspace close")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let blocker = Task.detached { await store.holdConsentStore(started: started, release: release) }
        await fulfillment(of: [started], timeout: 2)
        model?.setAutomaticReviewEnabled(false)
        let pendingSave = try XCTUnwrap(model?.automaticReviewSettingsTask)
        // Close before the newly created MainActor task gets its first turn.
        model = nil
        release.signal()
        let released = await blocker.value
        XCTAssertTrue(released)
        await pendingSave.value
        let saved = try await store.loadAutomaticReviewEnabled()
        XCTAssertFalse(saved, "关闭窗口不能丢弃已经要求保存的撤销授权")
        try await waitUntil { releasedModel == nil }
    }

}
