@testable import CharacterCore
import Foundation
import XCTest
@testable import PetCompanion

final class ModelAcceptanceTests: XCTestCase {
    private func suggestions(_ fixtures: [ModelAcceptanceRunner.MemoryFixture]) throws -> [CharacterMemorySuggestion] {
        let entries: [[String: Any]] = fixtures.compactMap { fixture in
            guard let kind = fixture.expectedKind else { return nil }
            let names: [CharacterMemoryKind: String] = [.fact: "fact", .preference: "preference", .episode: "episode"]
            return ["kind": names[kind]!, "quote": fixture.turn.text, "confidence": 0.99,
                    "turnID": fixture.turn.id.uuidString]
        }
        let data = try JSONSerialization.data(withJSONObject: ["suggestions": entries])
        return try CharacterMemorySuggestion.parse(String(decoding: data, as: UTF8.self), turns: fixtures.map(\.turn))
    }

    func testFixedCorpusHasEighteenDeterministicTurnsAndThreeSixTurnBatches() {
        let batches = ModelAcceptanceRunner.memoryBatches
        XCTAssertEqual(batches.map { $0.fixtures.count }, [6, 6, 6])
        let fixtures = batches.flatMap(\.fixtures)
        XCTAssertEqual(Set(fixtures.map { $0.turn.id }).count, 18)
        XCTAssertEqual(fixtures.map(\.turn), ModelAcceptanceRunner.memoryBatches.flatMap(\.fixtures).map(\.turn))
        XCTAssertEqual(Set(fixtures.map(\.category)), Set(ModelAcceptanceRunner.MemoryCategory.allCases))
        for batch in batches {
            XCTAssertEqual(CharacterMemorySuggestion.eligibleTurns(batch.fixtures.map(\.turn)).count, 6)
        }
    }

    func testGoldenReviewerUsesOnlyThreeCallsAndSeparatesCandidatesFromSimulatedSaves() async throws {
        var calls = 0
        let report = await ModelAcceptanceRunner().runMemory { turns in
            calls += 1
            let fixtures = ModelAcceptanceRunner.memoryBatches.flatMap(\.fixtures).filter { turns.map(\.id).contains($0.turn.id) }
            return try self.suggestions(fixtures)
        }
        XCTAssertEqual(calls, 3)
        XCTAssertEqual(report.batchesSucceeded, 3)
        XCTAssertEqual(report.extractionPrecision, .init(numerator: 8, denominator: 8))
        XCTAssertEqual(report.extractionRecall, .init(numerator: 8, denominator: 8))
        XCTAssertEqual(report.quoteValidity, .init(numerator: 8, denominator: 8))
        XCTAssertEqual(report.wrongAutoSaveRate, .init(numerator: 0, denominator: 6))
        XCTAssertEqual(report.riskBlockingRate, .init(numerator: 12, denominator: 12))
        XCTAssertEqual(report.riskBlockingAmongSuggestions, .init(numerator: 2, denominator: 2))
        XCTAssertEqual(report.simulatedAutoSaved, 6)
        XCTAssertEqual(report.pendingCandidates, 2)
        XCTAssertEqual(report.actualSaved, 0)
        XCTAssertTrue(report.failures.isEmpty)
        let data = try JSONEncoder().encode(report)
        XCTAssertEqual(try JSONDecoder().decode(ModelAcceptanceRunner.MemoryReport.self, from: data), report)
    }

    func testUncriticalReviewerExposesUnsafeAutosavesInsteadOfInventingExtraPolicy() async throws {
        let report = await ModelAcceptanceRunner().runMemory { turns in
            let entries = turns.map { ["kind": "preference", "quote": $0.text, "confidence": 0.99,
                                       "turnID": $0.id.uuidString] as [String: Any] }
            let data = try JSONSerialization.data(withJSONObject: ["suggestions": entries])
            return try CharacterMemorySuggestion.parse(String(decoding: data, as: UTF8.self), turns: turns)
        }
        XCTAssertEqual(report.returnedSuggestions, 18)
        XCTAssertEqual(report.quoteValidity.denominator, 18)
        XCTAssertGreaterThan(report.wrongAutoSaveRate.numerator, 0)
        XCTAssertGreaterThan(report.pendingCandidates, 0)
        XCTAssertLessThan(report.riskBlockingRate.numerator, report.riskBlockingRate.denominator)
        XCTAssertTrue(report.failures.contains { $0.code == .unexpectedAutoSave })
        XCTAssertEqual(report.actualSaved, 0)
    }

    func testEvidenceValidationAndDuplicatesCannotInflateRecall() async throws {
        let report = await ModelAcceptanceRunner().runMemory { turns in
            let fixtures = ModelAcceptanceRunner.memoryBatches.flatMap(\.fixtures).filter { turns.map(\.id).contains($0.turn.id) }
            guard let first = try self.suggestions(fixtures).first else { return [] }
            var invalidMemory = first.memory
            invalidMemory.text = "从未说过的合成内容"
            let invalid = CharacterMemorySuggestion(memory: invalidMemory, confidence: 1, isCompleteTurn: true)
            return [first, first, invalid]
        }
        XCTAssertEqual(report.returnedSuggestions, 9)
        XCTAssertEqual(report.quoteValidity, .init(numerator: 6, denominator: 9))
        XCTAssertEqual(report.extractionRecall, .init(numerator: 3, denominator: 8))
        XCTAssertEqual(report.extractionPrecision, .init(numerator: 3, denominator: 9))
        XCTAssertEqual(report.invalidEvidence, 3)
        // The repeated correction remains a review candidate, not an already-saved memory.
        XCTAssertEqual(report.alreadyExisting, 2)
        XCTAssertEqual(report.pendingCandidates, 2)
        XCTAssertTrue(report.failures.contains { $0.code == .invalidEvidence })
    }

    func testContextlessPartialQuoteCannotEarnGoldRecallOrBeAutosaved() async throws {
        let report = await ModelAcceptanceRunner().runMemory { turns in
            let turn = turns[0]
            let memory = CharacterMemory(kind: .fact, text: String(turn.text.prefix(1)), source: "合成测试",
                                         citation: "turn:\(turn.id.uuidString)")
            return [CharacterMemorySuggestion(memory: memory, confidence: 1, isCompleteTurn: false)]
        }
        XCTAssertEqual(report.quoteValidity, .init(numerator: 3, denominator: 3))
        XCTAssertEqual(report.extractionPrecision, .init(numerator: 0, denominator: 3))
        XCTAssertEqual(report.extractionRecall, .init(numerator: 0, denominator: 8))
        XCTAssertEqual(report.simulatedAutoSaved, 0)
        XCTAssertEqual(report.pendingCandidates, 3)
    }

    func testForeignCitationNonfiniteConfidenceAndForgedCompleteFlagAreRejected() async throws {
        let report = await ModelAcceptanceRunner().runMemory { turns in
            let first = try self.suggestions(ModelAcceptanceRunner.memoryBatches.flatMap(\.fixtures)
                .filter { turns.map(\.id).contains($0.turn.id) }).first!
            var foreign = first.memory
            foreign.citation = "turn:00000000-0000-4000-8000-000000000099"
            return [CharacterMemorySuggestion(memory: foreign, confidence: 1, isCompleteTurn: true),
                    CharacterMemorySuggestion(memory: first.memory, confidence: .nan, isCompleteTurn: true),
                    CharacterMemorySuggestion(memory: first.memory, confidence: 1, isCompleteTurn: false)]
        }
        XCTAssertEqual(report.quoteValidity, .init(numerator: 0, denominator: 9))
        XCTAssertEqual(report.invalidEvidence, 9)
        XCTAssertEqual(report.simulatedAutoSaved, 0)
        XCTAssertEqual(report.riskBlockingAmongSuggestions, .init(numerator: 9, denominator: 9))
    }

    func testEmptyReviewerHasUndefinedPrecisionAndMissesAllExpectedMemories() async {
        let report = await ModelAcceptanceRunner().runMemory { _ in [] }
        XCTAssertNil(report.extractionPrecision.value)
        XCTAssertNil(report.quoteValidity.value)
        XCTAssertNil(report.wrongAutoSaveRate.value)
        XCTAssertNil(report.riskBlockingAmongSuggestions.value)
        XCTAssertEqual(report.extractionRecall, .init(numerator: 0, denominator: 8))
        XCTAssertEqual(report.riskBlockingRate, .init(numerator: 12, denominator: 12))
        XCTAssertEqual(report.failures.filter { $0.code == .missedExpectedSuggestion }.count, 8)
    }

    func testTransportErrorsAreSanitizedInCodableReports() async throws {
        let unsafeError = NSError(domain: "https://private.invalid/?key=synthetic-secret", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "synthetic-secret"])
        let runner = ModelAcceptanceRunner()
        let memory = await runner.runMemory { _ in throw unsafeError }
        let replies = await runner.runReplies { _ in throw unsafeError }
        let encoder = JSONEncoder()
        for data in [try encoder.encode(memory), try encoder.encode(replies)] {
            let json = String(decoding: data, as: UTF8.self)
            XCTAssertFalse(json.contains("synthetic-secret"))
            XCTAssertFalse(json.contains("private.invalid"))
        }
    }

    func testFailuresAreRecordedOncePerBatchWithoutRetryOrVacuousPerfectScores() async throws {
        enum SyntheticFailure: Error { case offline }
        var calls = 0
        let report = await ModelAcceptanceRunner().runMemory { _ in
            calls += 1
            throw SyntheticFailure.offline
        }
        XCTAssertEqual(calls, 3)
        XCTAssertEqual(report.batchesSucceeded, 0)
        XCTAssertEqual(report.failures.filter { $0.code == .reviewFailed }.count, 3)
        XCTAssertNil(report.extractionPrecision.value)
        XCTAssertNil(report.quoteValidity.value)
        XCTAssertEqual(report.extractionRecall, .init(numerator: 0, denominator: 8))
        XCTAssertEqual(report.riskBlockingRate, .init(numerator: 0, denominator: 12))
    }

    func testRepliesAreFourPairedSyntheticFixturesAndFailureIsNotRetried() async throws {
        enum SyntheticFailure: Error { case offline }
        let fixtures = ModelAcceptanceRunner.replyFixtures
        XCTAssertEqual(fixtures.count, 4)
        XCTAssertEqual(fixtures[0].prompt, "解释一下缓存为什么能加速，举一个虚构书桌的例子。")
        XCTAssertEqual(fixtures[2].prompt, "把整理虚构书桌的步骤和原因讲给我听。")
        XCTAssertNil(fixtures[0].profilePrompt)
        XCTAssertNotNil(fixtures[1].profilePrompt)
        XCTAssertEqual(fixtures[0].prompt, fixtures[1].prompt)
        XCTAssertEqual(fixtures[2].prompt, fixtures[3].prompt)
        var calls = 0
        let report = await ModelAcceptanceRunner().runReplies { fixture in
            calls += 1
            if fixture.id == fixtures[1].id { throw SyntheticFailure.offline }
            return "合成简短回复。"
        }
        XCTAssertEqual(calls, 4)
        XCTAssertEqual(report.results.count, 3)
        XCTAssertEqual(report.comparisons.count, 2)
        XCTAssertEqual(report.comparisons[0].baselineCharacters, "合成简短回复。".count)
        XCTAssertNil(report.comparisons[0].adaptedCharacters, "Failed replies are unknown, not zero-length successes")
        XCTAssertEqual(report.comparisons[1].baselineCharacters, "合成简短回复。".count)
        XCTAssertEqual(report.comparisons[1].adaptedCharacters, "合成简短回复。".count)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertEqual(report.failures.first?.code, .replyFailed)
        XCTAssertEqual(try JSONDecoder().decode(ModelAcceptanceRunner.ReplyReport.self,
            from: JSONEncoder().encode(report)), report)
        XCTAssertFalse(ModelAcceptanceRunner.speechFixture.text.isEmpty)
        XCTAssertEqual(ModelAcceptanceRunner.bubbleFixture.event, "idle")
        XCTAssertLessThanOrEqual(3 + fixtures.count + 1 + 1, ModelRequestLedger.maximumAttempts)
    }
}
