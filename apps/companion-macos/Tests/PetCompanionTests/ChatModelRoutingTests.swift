import CharacterCore
import Foundation
import XCTest
@testable import PetCompanion

@MainActor
final class ChatModelRoutingTests: XCTestCase {
    func testChatSelectionReachesCompletionWhileVoiceKeepsDefault() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var settings = ModelProviderSettings()
        settings.availableModels = ["synthetic-b"]
        var received: [String] = []
        var purposes: [ModelReplyPurpose] = []
        let provider = CharacterChatProvider(credentials: { _ in (settings, "synthetic-token") },
            complete: { settings, _, _, _, _, purpose in purposes.append(purpose); received.append(settings.model); return "合成回复" })
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()),
                                      mode: .controlTest, characterChatProvider: provider)
        let choice = CharacterChatModelSelection(model: "synthetic-b", serviceID: settings.chatCatalog.serviceID)
        _ = try await coordinator.replyToCharacterChat("请写一个合成故事", history: [], modelSelection: choice)
        _ = try await coordinator.replyToCharacterChat("请写另一个合成故事", history: [], memorySource: "用户语音明确指令", replyPurpose: .speech)
        XCTAssertEqual(received, ["synthetic-b", settings.model])
        XCTAssertEqual(purposes, [.textChat, .speech])
    }

    func testStaleServiceChoiceIsRejectedBeforeCompletion() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let provider = CharacterChatProvider(credentials: { _ in (ModelProviderSettings(), "synthetic-token") },
            complete: { _, _, _, _, _, _ in XCTFail("Stale selections must never reach completion"); return "unexpected" })
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()),
                                      mode: .controlTest, characterChatProvider: provider)
        do {
            _ = try await coordinator.replyToCharacterChat("请写一个合成故事", history: [],
                modelSelection: .init(model: "unknown", serviceID: "old-service"))
            XCTFail("Expected stale service choice to be rejected")
        } catch { XCTAssertTrue(error.localizedDescription.contains("重新选择")) }
        // Even a stale model choice must not interfere with deterministic local answers.
        let local = try await coordinator.replyToCharacterChat("你是谁", history: [],
            modelSelection: .init(model: "unknown", serviceID: "old-service"))
        XCTAssertTrue(local.contains("龙妹"))
    }
}
