import XCTest
@testable import DragonCore

final class PetInstancePlanningTests: XCTestCase {
    private func registry() throws -> PetInstanceRegistry {
        try .init(instances: ["first", "second", "third", "fourth", "disabled"].map {
            try .init(id: $0, package: .init(id: "local.dragon", version: "1.0.0"), enabled: $0 != "disabled")
        })
    }
    private func row(_ id: String, _ phase: PetInstancePhase) throws -> PetInstanceControlRow {
        let definition = try XCTUnwrap(registry().instances.first { $0.id == id })
        return .init(id: id, package: definition.package, enabled: definition.enabled,
                     preferences: definition.preferences, phase: phase)
    }
    func testColdRestoreObeysCapacityAndRegistryOrder() throws {
        XCTAssertEqual(PetInstancePlanning.restorationIDs(registry: try registry(), rows: [], maximumRunning: 3),
                       ["first", "second", "third"])
    }
    func testStoppingRowsOccupyCapacityAndCannotBecomeCandidates() throws {
        let rows = try [row("first", .stopping), row("second", .running)]
        XCTAssertEqual(PetInstancePlanning.restorationIDs(registry: try registry(), rows: rows, maximumRunning: 3), ["third"])
        XCTAssertTrue(PetInstancePlanning.restorationIDs(registry: try registry(), rows: rows, maximumRunning: 1).isEmpty)
    }
    func testFailedCanRetryButStartingAndDisabledAreSkipped() throws {
        let rows = try [row("first", .starting), row("second", .failed), row("third", .stopped), row("fourth", .running)]
        XCTAssertEqual(PetInstancePlanning.restorationIDs(registry: try registry(), rows: rows, maximumRunning: 8), ["second", "third"])
    }
    func testStartupStopExclusionDoesNotAffectOtherPets() throws {
        XCTAssertEqual(PetInstancePlanning.restorationIDs(registry: try registry(), rows: [], maximumRunning: 3,
                                                        excluding: ["first"]), ["second", "third", "fourth"])
    }
    func testCloneIDsRemainValidAtHyphenTruncationAndCollision() throws {
        let source = String(repeating: "a", count: 58) + "-bcde"
        let first = try XCTUnwrap(PetInstancePlanning.nextCloneID(sourceID: source, used: [source]))
        let second = try XCTUnwrap(PetInstancePlanning.nextCloneID(sourceID: source, used: [source, first]))
        for id in [first, second] {
            XCTAssertLessThanOrEqual(id.count, 64)
            XCTAssertNoThrow(try PetInstanceDefinition(id: id, package: .init(id: "local.dragon", version: "1.0.0")))
        }
        XCTAssertTrue(second.hasSuffix("-copy-2"))
        XCTAssertNil(PetInstancePlanning.nextCloneID(sourceID: "bad--id", used: []))
        XCTAssertNil(PetInstancePlanning.nextCloneID(sourceID: "dragon", used: Set((0..<32).map { "pet-\($0)" })))
    }
}
