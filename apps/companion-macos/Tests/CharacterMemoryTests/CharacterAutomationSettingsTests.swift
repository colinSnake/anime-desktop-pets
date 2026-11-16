import CharacterCore
import CharacterMemory
import XCTest

final class CharacterAutomationSettingsTests: XCTestCase {
    func testDefaultOffRoundTripAndPetIsolation() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let a = try CharacterMemoryStore(stateDirectory: dir, petID: "one")
        let b = try CharacterMemoryStore(stateDirectory: dir, petID: "two")
        let initial = try await a.loadAutomaticReviewEnabled()
        XCTAssertFalse(initial)
        try await a.saveAutomaticReviewEnabled(true)
        let restored = try await CharacterMemoryStore(stateDirectory: dir, petID: "one").loadAutomaticReviewEnabled()
        let other = try await b.loadAutomaticReviewEnabled()
        XCTAssertTrue(restored)
        XCTAssertFalse(other)
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)!.allObjects as! [URL]
        let file = try XCTUnwrap(files.first { $0.lastPathComponent == "automation-settings.json" })
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try FileManager.default.removeItem(at: file)
        let outside = dir.appendingPathComponent("outside.json")
        try Data("{\"enabled\":true}".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
        do { _ = try await a.loadAutomaticReviewEnabled(); XCTFail("拒绝符号链接") } catch {}
        do { try await a.saveAutomaticReviewEnabled(false); XCTFail("拒绝覆写符号链接") } catch {}
    }
}
