import XCTest
@testable import CharacterCore

final class CharacterKnowledgeProvenanceAnswerTests: XCTestCase {
    func testSourceQuestionIncludesEvidenceEvenWhenKnowledgeBodyIsLong() throws {
        let memory = CharacterMemory(kind: .knowledge, text: "琥珀书房：" + String(repeating: "合成说明", count: 100),
            source: "合成设定手册", citation: "第3页", version: "验收版2026-11-15", status: .confirmed)
        let answer = try XCTUnwrap(CharacterLocalAnswer.answer(for: "琥珀书房的知识来源是什么", identity: .starter(name: "合成角色"),
            memories: [memory], capabilities: []))
        XCTAssertTrue(answer.contains("来源：合成设定手册"), answer)
        XCTAssertTrue(answer.contains("引用：第3页"), answer)
        XCTAssertTrue(answer.contains("版本：验收版2026-11-15"), answer)
        XCTAssertLessThanOrEqual(answer.count, 120)
    }

    func testBasisQuestionIsAnsweredLocallyWithProvenance() throws {
        let memory = CharacterMemory(kind: .knowledge, text: "晨光阁是合成藏书室", source: "合成补充手册", status: .confirmed)
        let answer = try XCTUnwrap(CharacterLocalAnswer.answer(for: "晨光阁的依据是什么", identity: .starter(name: "合成角色"),
            memories: [memory], capabilities: []))
        XCTAssertTrue(answer.contains("来源：合成补充手册"), answer)
    }
}
