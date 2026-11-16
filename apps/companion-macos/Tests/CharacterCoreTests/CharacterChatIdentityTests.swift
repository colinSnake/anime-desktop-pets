import CharacterCore
import Foundation
import XCTest

final class CharacterChatIdentityTests: XCTestCase {
    private func id(in turn: CharacterChatTurn) throws -> String {
        let data = try JSONEncoder().encode(turn)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(object["id"] as? String, "Messages need a stable identity independent of their array index")
    }

    func testMessageIdentitySurvivesTrimmingRebuildingAndCodableRoundTrip() throws {
        let original = CharacterChatTurn(role: .user, text: String(repeating: "字", count: 1_300))
        let originalID = try id(in: original)
        let session = CharacterChatSession(turns: [original])
        let clipped = try XCTUnwrap(session.turns.first)
        XCTAssertEqual(clipped.text.count, 1_200)
        XCTAssertEqual(try id(in: clipped), originalID)
        let rebuilt = CharacterChatSession(turns: session.turns)
        XCTAssertEqual(try id(in: XCTUnwrap(rebuilt.turns.first)), originalID)
        let decoded = try JSONDecoder().decode(CharacterChatTurn.self, from: JSONEncoder().encode(clipped))
        XCTAssertEqual(try id(in: decoded), originalID)
    }

    func testIdenticalMessagesGetDifferentIdentitiesAndLegacyTurnsStillDecode() throws {
        let date = Date(timeIntervalSinceReferenceDate: 1_000)
        let first = CharacterChatTurn(role: .assistant, text: "相同回复", createdAt: date)
        let second = CharacterChatTurn(role: .assistant, text: "相同回复", createdAt: date)
        XCTAssertNotEqual(try id(in: first), try id(in: second))
        let legacy = try JSONDecoder().decode(CharacterChatTurn.self,
            from: Data(#"{"role":"assistant","text":"旧消息"}"#.utf8))
        XCTAssertEqual(legacy.text, "旧消息")
        XCTAssertNil(legacy.createdAt)
        XCTAssertFalse(try id(in: legacy).isEmpty)
    }
}
