import CharacterCore
import CharacterMemory
import Foundation
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterChatMessageTimestampTests: XCTestCase {
    func testAssistantTimeUses24HourClockWithLeadingZeroesAndSecondsInChosenZone() throws {
        let turn = CharacterChatTurn(role: .assistant, text: "合成回复", createdAt: Date(timeIntervalSinceReferenceDate: 3_723))
        XCTAssertEqual(CharacterChatMessageView.timestampText(for: turn, timeZone: try XCTUnwrap(TimeZone(secondsFromGMT: 0))), "01:02:03")
        XCTAssertEqual(CharacterChatMessageView.timestampText(for: turn, timeZone: try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))), "09:02:03")
    }

    func testUserAndLegacyMessagesDoNotShowTimestamp() {
        let user = CharacterChatTurn(role: .user, text: "合成问题", createdAt: Date(timeIntervalSinceReferenceDate: 3_723))
        let legacy = CharacterChatTurn(role: .assistant, text: "旧合成回复", createdAt: nil)
        XCTAssertNil(CharacterChatMessageView.timestampText(for: user))
        XCTAssertNil(CharacterChatMessageView.timestampText(for: legacy))
    }

    func testAssistantTimestampIsCapturedAfterReplyNotAtRequestAndSurvivesRefresh() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic-time")
        var replyFinishedAt: Date?
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹", chat: { _, _, _ in
            try await Task.sleep(nanoseconds: 20_000_000)
            replyFinishedAt = Date()
            return "合成回复"
        })
        model.sendChat("合成问题")
        for _ in 0..<100 where model.isChatSending { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertFalse(model.isChatSending)
        let turn = try XCTUnwrap(model.chatTurns.last)
        XCTAssertEqual(turn.role, .assistant)
        let timestamp = try XCTUnwrap(turn.createdAt)
        XCTAssertGreaterThanOrEqual(timestamp, try XCTUnwrap(replyFinishedAt))
        XCTAssertLessThanOrEqual(timestamp, Date())
        let requestTime = try XCTUnwrap(model.chatTurns.first?.createdAt)
        XCTAssertGreaterThan(timestamp, requestTime)
        model.refreshChatModels()
        model.chatDraft = "新的草稿"
        XCTAssertEqual(model.chatTurns.last?.createdAt, timestamp)
    }
}
