import XCTest
@testable import PetCompanion

@MainActor
final class PetAIBubbleTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pet-bubble-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testDefaultOffDoesNotGenerate() async throws {
        let directory = try directory()
        var calls = 0
        let service = PetAIBubbleService(stateDirectory: directory) { _ in calls += 1; return "陪你坐一会儿。" }
        let reply = await service.reply(to: .idle)
        XCTAssertNil(reply)
        XCTAssertEqual(calls, 0)
    }

    func testCooldownPersistsAcrossServiceRecreationAndFailuresCount() async throws {
        let directory = try directory()
        var settings = SpeechSettings(); settings.aiBubblesEnabled = true
        try SpeechSettingsStore(stateDirectory: directory).save(settings)
        var calls = 0
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let first = PetAIBubbleService(stateDirectory: directory, now: { now }) { _ in
            calls += 1; throw URLError(.timedOut)
        }
        let failed = await first.reply(to: .idle)
        XCTAssertNil(failed)
        let reopened = PetAIBubbleService(stateDirectory: directory, now: { now.addingTimeInterval(599) }) { _ in
            calls += 1; return "陪你坐一会儿。"
        }
        let denied = await reopened.reply(to: .idle)
        XCTAssertNil(denied)
        XCTAssertEqual(calls, 1)
    }

    func testDayLimitAndNewDay() async throws {
        let directory = try directory()
        var settings = SpeechSettings(); settings.aiBubblesEnabled = true
        try SpeechSettingsStore(stateDirectory: directory).save(settings)
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var calls = 0
        let service = PetAIBubbleService(stateDirectory: directory, now: { now }) { _ in
            calls += 1; return "歇一歇眼睛，我还在这儿。"
        }
        for _ in 0..<12 { _ = await service.reply(to: .idle); now.addTimeInterval(600) }
        let denied = await service.reply(to: .idle)
        XCTAssertNil(denied)
        XCTAssertEqual(calls, 12)
        now.addTimeInterval(86400)
        let nextDay = await service.reply(to: .idle)
        XCTAssertNotNil(nextDay)
        XCTAssertEqual(calls, 13)
    }

    func testRevocationAndRegrantDiscardsInflightResponse() async throws {
        let directory = try directory()
        let store = SpeechSettingsStore(stateDirectory: directory)
        var settings = SpeechSettings(); settings.aiBubblesEnabled = true
        try store.save(settings)
        let service = PetAIBubbleService(stateDirectory: directory) { _ in
            var disabled = try store.load(); disabled.aiBubblesEnabled = false; try store.save(disabled)
            disabled.aiBubblesEnabled = true; try store.save(disabled)
            return "陪你坐一会儿。"
        }
        let reply = await service.reply(to: .idle)
        XCTAssertNil(reply)
    }

    func testOutputRejectsClaimsCredentialsAndOversize() {
        XCTAssertEqual(PetAIBubbleService.safeLine("陪你坐一会儿。"), "陪你坐一会儿。")
        for value in ["任务已经完成了。", "我帮你提交了代码。", "https://example.com", "第一行\n第二行", String(repeating: "字", count: 61), ""] {
            XCTAssertNil(PetAIBubbleService.safeLine(value), value)
        }
    }
}
