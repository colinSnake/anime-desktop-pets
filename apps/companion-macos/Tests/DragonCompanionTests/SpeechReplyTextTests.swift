import XCTest
@testable import DragonCompanion

final class SpeechReplyTextTests: XCTestCase {
    func testShortReplyRetainsContentAndNormalizesWhitespaceForBothSpeechAndBubble() {
        XCTAssertEqual(SpeechReplyText.prepare("  书房进度：\n1/2  步\t下一步贴标签  "), "书房进度： 1/2 步 下一步贴标签")
        XCTAssertNil(SpeechReplyText.prepare(" \n\t "))
    }

    func testLongLocalAnswersAndMultibyteCharactersFitBothProtocols() throws {
        for text in [String(repeating: "知识段落。", count: 200), String(repeating: "🐉👨‍👩‍👧‍👦", count: 100), String(repeating: "a", count: 1000)] {
            let reply = try XCTUnwrap(SpeechReplyText.prepare(text))
            XCTAssertLessThanOrEqual(reply.count, 160)
            XCTAssertLessThanOrEqual(reply.utf8.count, 512)
            XCTAssertTrue(reply.hasSuffix("…"))
            let json = try JSONSerialization.data(withJSONObject: ["type": "respond", "text": reply, "speak": true])
            XCTAssertLessThanOrEqual(json.count, 8192)
        }
    }
}
