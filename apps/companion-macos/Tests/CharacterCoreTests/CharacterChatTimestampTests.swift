import CharacterCore
import Foundation
import XCTest

final class CharacterChatTimestampTests: XCTestCase {
    private func encodedTurn(_ turn: CharacterChatTurn) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(turn)) as? [String: Any])
    }

    func testAssistantAppendCapturesTimeOnceAndKeepsItWhenSessionIsRebuilt() throws {
        let before = Date().timeIntervalSinceReferenceDate
        var session = CharacterChatSession()
        session.append(role: .assistant, text: "合成回复")
        let turn = try XCTUnwrap(session.turns.first)
        let timestamp = try XCTUnwrap(try encodedTurn(turn)["createdAt"] as? Double)
        XCTAssertGreaterThanOrEqual(timestamp, before)
        XCTAssertLessThanOrEqual(timestamp, Date().timeIntervalSinceReferenceDate)
        let rebuilt = CharacterChatSession(turns: session.turns)
        XCTAssertEqual(try encodedTurn(try XCTUnwrap(rebuilt.turns.first))["createdAt"] as? Double, timestamp)
    }

    func testBoundedSessionPreservesOriginalTimestampWhileTrimmingTextAndTurns() throws {
        let data = Data(#"{"role":"assistant","text":"  合成回复  ","createdAt":3723}"#.utf8)
        let turn = try JSONDecoder().decode(CharacterChatTurn.self, from: data)
        let olderTurns = (0..<CharacterChatSession.maxTurns).map {
            CharacterChatTurn(role: .user, text: "更早的合成问题 \($0)")
        }
        var session = CharacterChatSession(turns: olderTurns + [turn])
        session.append(role: .user, text: "下一条合成问题")
        XCTAssertEqual(session.turns.count, CharacterChatSession.maxTurns)
        let preserved = try XCTUnwrap(session.turns.first(where: { $0.role == .assistant }))
        XCTAssertEqual(preserved.text, "合成回复")
        XCTAssertEqual(try encodedTurn(preserved)["createdAt"] as? Double, 3723)
    }

    func testLegacyTranscriptWithoutTimestampRemainsUnknownRatherThanInventingNow() throws {
        let data = Data(#"{"role":"assistant","text":"旧格式合成回复"}"#.utf8)
        let turn = try JSONDecoder().decode(CharacterChatTurn.self, from: data)
        let session = CharacterChatSession(turns: [turn])
        XCTAssertNil(try encodedTurn(try XCTUnwrap(session.turns.first))["createdAt"])
    }
}
