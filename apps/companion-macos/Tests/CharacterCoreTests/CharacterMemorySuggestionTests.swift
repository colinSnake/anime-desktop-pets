import XCTest
@testable import CharacterCore

final class CharacterMemorySuggestionTests: XCTestCase {
    let turn = CharacterChatTurn(role: .user, text: "我喜欢喝绿茶")

    func payload(kind: String = "preference", quote: String = "我喜欢喝绿茶", confidence: Double = 0.95,
                 id: UUID? = nil) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["suggestions": [[
            "kind": kind, "quote": quote, "confidence": confidence,
            "turnID": (id ?? turn.id).uuidString
        ]]])
        return String(decoding: data, as: UTF8.self)
    }

    func testExactQuoteCanAutoConfirmWithoutOnlineSharing() throws {
        let suggestions = try CharacterMemorySuggestion.parse(payload(), turns: [turn])
        let item = try XCTUnwrap(suggestions.first)
        XCTAssertEqual(item.memory.text, "我喜欢喝绿茶")
        XCTAssertEqual(item.memory.kind, .preference)
        XCTAssertFalse(item.memory.shareWithOnlineModel)
        XCTAssertEqual(item.decision(against: []), .autoConfirm)
        var existing = item.memory
        existing.id = UUID().uuidString.lowercased()
        existing.status = .confirmed
        XCTAssertEqual(item.decision(against: [existing]), .alreadyExists(existing))
    }

    func testUnboundOrDisallowedSuggestionsCannotBeStored() throws {
        for data in [try payload(id: UUID()), try payload(quote: "我喜欢咖啡"),
                     try payload(kind: "knowledge"), try payload(confidence: 1.1), try payload(quote: "")] {
            XCTAssertThrowsError(try CharacterMemorySuggestion.parse(data, turns: [turn]))
        }
        XCTAssertThrowsError(try CharacterMemorySuggestion.parse(payload(), turns: [
            CharacterChatTurn(role: .assistant, text: turn.text, id: turn.id)
        ]))
        let array = Array(repeating: try JSONSerialization.jsonObject(with: Data(payload().utf8)) as! [String: Any], count: 7)
        let tooMany = try JSONSerialization.data(withJSONObject: ["suggestions": array.map { ($0["suggestions"] as! [Any])[0] }])
        XCTAssertThrowsError(try CharacterMemorySuggestion.parse(String(decoding: tooMany, as: UTF8.self), turns: [turn]))
    }

    func testLowConfidenceNeedsReviewAndCredentialsAreRejected() throws {
        let uncertain = try XCTUnwrap(CharacterMemorySuggestion.parse(payload(confidence: 0.89), turns: [turn]).first)
        guard case .requiresReview = uncertain.decision(against: []) else { return XCTFail("低置信度不得自动确认") }
        let credential = CharacterChatTurn(role: .user, text: "我的密码是合成数据")
        let item = try XCTUnwrap(CharacterMemorySuggestion.parse(payload(quote: credential.text, id: credential.id), turns: [credential]).first)
        XCTAssertEqual(item.decision(against: []), .doNotStore)
    }

    func testSensitiveAndConflictingSuggestionsRequireManualReview() throws {
        let sensitiveTurn = CharacterChatTurn(role: .user, text: "我的银行卡偏好是合成测试")
        let sensitiveJSON = try payload(quote: sensitiveTurn.text, id: sensitiveTurn.id)
        let sensitive = try XCTUnwrap(CharacterMemorySuggestion.parse(sensitiveJSON, turns: [sensitiveTurn]).first)
        guard case .requiresReview = sensitive.decision(against: []) else {
            return XCTFail("敏感内容必须转人工")
        }
        var existing = CharacterMemory(kind: .preference, text: "我不喜欢喝绿茶", source: "合成测试", status: .confirmed)
        existing.shareWithOnlineModel = false
        let proposal = try XCTUnwrap(CharacterMemorySuggestion.parse(payload(), turns: [turn]).first)
        guard case .requiresReview = proposal.decision(against: [existing]) else {
            return XCTFail("冲突内容必须转人工")
        }
    }
}
