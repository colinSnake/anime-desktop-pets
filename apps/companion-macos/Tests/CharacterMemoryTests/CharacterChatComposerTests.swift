import CharacterCore
import CharacterMemory
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterChatComposerTests: XCTestCase {
    private func makeStore() throws -> (URL, CharacterMemoryStore) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "test-pet")
        return (dir, store)
    }

    func testModelSelectionRefreshAndServiceIsolation() throws {
        let (dir, store) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        var catalog = CharacterChatModelCatalog(serviceID: "service-a", providerName: "测试服务", models: ["a", "b"], defaultModel: "a")
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹", chatModels: { catalog })
        model.refreshChatModels()
        XCTAssertEqual(model.selectedChatModel, "a")
        model.selectChatModel("b")
        model.refreshChatModels()
        XCTAssertEqual(model.selectedChatModel, "b")
        model.selectChatModel("unknown")
        XCTAssertEqual(model.selectedChatModel, "b")
        catalog = .init(serviceID: "service-b", providerName: "另一服务", models: ["b", "c"], defaultModel: "c")
        model.refreshChatModels()
        XCTAssertEqual(model.selectedChatModel, "c")
        catalog = .init(serviceID: "service-b", providerName: "另一服务", models: ["b"], defaultModel: "b")
        model.refreshChatModels()
        XCTAssertEqual(model.selectedChatModel, "b")
    }

    func testFailedCatalogRefreshClearsStaleChoicesButNotDraft() throws {
        let (dir, store) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        var shouldFail = false
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹", chatModels: {
            if shouldFail { throw CocoaError(.fileReadCorruptFile) }
            return .init(serviceID: "s", providerName: "测试", models: ["a"], defaultModel: "a")
        })
        model.refreshChatModels()
        model.chatDraft = "未发送的草稿"
        shouldFail = true
        model.refreshChatModels()
        XCTAssertNil(model.selectedChatModel)
        XCTAssertNil(model.chatModelCatalog)
        XCTAssertFalse(model.chatModelError.isEmpty)
        XCTAssertEqual(model.chatDraft, "未发送的草稿")
    }

    func testSendCapturesSelectionAndRejectsDuplicateWhileBusy() async throws {
        let (dir, store) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        var captured: CharacterChatModelSelection?
        var calls = 0
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹", chat: { _, _, selection in
            captured = selection
            calls += 1
            try await Task.sleep(nanoseconds: 20_000_000)
            return "测试回复"
        }, chatModels: { .init(serviceID: "s", providerName: "测试", models: ["a", "b"], defaultModel: "a") })
        model.refreshChatModels()
        model.selectChatModel("b")
        model.chatDraft = "你好"
        model.sendDraft()
        XCTAssertEqual(model.chatDraft, "")
        model.chatDraft = "下一条草稿"
        model.selectChatModel("a")
        model.sendDraft()
        model.clearChat()
        XCTAssertEqual(model.selectedChatModel, "b")
        XCTAssertEqual(model.chatDraft, "下一条草稿")
        XCTAssertEqual(model.chatTurns.count, 1)
        for _ in 0..<100 where model.isChatSending { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(captured, .init(model: "b", serviceID: "s"))
        XCTAssertEqual(model.chatTurns.map(\.text), ["你好", "测试回复"])
        model.clearChat()
        XCTAssertTrue(model.chatTurns.isEmpty)
        XCTAssertEqual(model.chatDraft, "下一条草稿", "Clearing a conversation must not discard a draft")
    }

    func testInvalidDraftIsNotDiscarded() throws {
        let (dir, store) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹", chat: { _, _, _ in "unused" })
        model.chatDraft = String(repeating: "字", count: 1_201)
        model.sendDraft()
        XCTAssertEqual(model.chatDraft.count, 1_201)
        XCTAssertTrue(model.chatTurns.isEmpty)
    }
}

extension CharacterChatComposerTests {
    func testDiscoveryIsExplicitAndPreservesChatDraftSelectionAndManualChoicesOnFailure() async throws {
        let (dir, store) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        var calls = 0
        let catalog = CharacterChatModelCatalog(serviceID: "synthetic", providerName: "合成服务", models: ["manual"], defaultModel: "manual")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in "合成答复" },
            chatModels: { catalog }, discoverChatModels: { id in
                XCTAssertEqual(id, catalog.serviceID)
                calls += 1
                throw URLError(.unsupportedURL)
            })
        model.refreshChatModels()
        XCTAssertEqual(calls, 0, "Opening the popover must only load saved settings")
        model.chatDraft = "合成草稿"
        model.discoverChatModels()
        model.discoverChatModels()
        for _ in 0..<100 where model.isDiscoveringChatModels { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(model.chatDraft, "合成草稿")
        XCTAssertEqual(model.selectedChatModel, "manual")
        XCTAssertEqual(model.chatModelCatalog, catalog)
        XCTAssertFalse(model.chatModelError.isEmpty)
    }

    func testDiscoveryRejectsDifferentServiceAndDoesNotClearTranscript() async throws {
        let (dir, store) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        var catalog = CharacterChatModelCatalog(serviceID: "old", providerName: "旧服务", models: ["manual"], defaultModel: "manual")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in "已有答复" },
            chatModels: { catalog }, discoverChatModels: { _ in
                catalog = .init(serviceID: "new", providerName: "新服务", models: ["new-model"], defaultModel: "new-model")
                return .init(serviceID: "old", providerName: "旧服务", models: ["stale-model"], defaultModel: "stale-model")
            })
        model.refreshChatModels()
        model.sendChat("合成问题")
        for _ in 0..<100 where model.isChatSending { try await Task.sleep(nanoseconds: 1_000_000) }
        let transcript = model.chatTurns
        model.discoverChatModels()
        for _ in 0..<100 where model.isDiscoveringChatModels { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(model.chatTurns, transcript)
        XCTAssertEqual(model.chatModelCatalog?.serviceID, "new")
        XCTAssertEqual(model.selectedChatModel, "new-model")
        XCTAssertFalse(model.chatModelError.isEmpty)
    }
}
