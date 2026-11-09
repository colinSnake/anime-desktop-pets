import CharacterCore
import CharacterMemory
import Foundation
import XCTest
@testable import DragonCompanion

@MainActor
final class CharacterOfflineFlowTests: XCTestCase {
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
        XCTAssertTrue(capabilities.contains("在线对话（暂不可用）"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("model-provider.json").path))
    }
}
