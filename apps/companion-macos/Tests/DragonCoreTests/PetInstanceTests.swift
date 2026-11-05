import Foundation
import XCTest
@testable import DragonCore

final class PetInstanceTests: XCTestCase {
    func testPetBuildIdentityMatchesArbitraryCurrentPatchAndBundleVersion() {
        let metadata: [String: Any] = ["patchVersion": "dragon.9", "upstreamVersion": "0.4.1-mac.3", "bundleVersion": "12"]
        XCTAssertTrue(PetBuildIdentity.supports(buildVersion: "12", patchVersion: "dragon.9", metadata: metadata))
        XCTAssertFalse(PetBuildIdentity.supports(buildVersion: "11", patchVersion: "dragon.9", metadata: metadata))
        XCTAssertFalse(PetBuildIdentity.supports(buildVersion: "12", patchVersion: "dragon.8", metadata: metadata))
        XCTAssertFalse(PetBuildIdentity.supports(buildVersion: "12", patchVersion: "dragon.invalid", metadata: metadata))
    }
    private func definition(_ id: String, packageID: String? = nil, enabled: Bool = true) throws -> PetInstanceDefinition {
        try .init(id: id, package: .init(id: packageID ?? "local.\(id)", version: "1.0.0"), enabled: enabled)
    }
    private func lifecycle(maximum: Int = 3) throws -> PetInstanceLifecycle {
        try .init(registry: .init(instances: [definition("first"), definition("second")]), maximumRunning: maximum)
    }
    func testRegistryRoundTrip() throws {
        let value = try PetInstanceRegistry(instances: [definition("first"), definition("second")])
        XCTAssertEqual(try PetInstanceRegistry.decode(JSONEncoder().encode(value)), value)
    }
    func testLegacyCloneWithoutAutoStartFieldStaysStoppedButOriginalRestores() throws {
        let json = #"{"schemaVersion":1,"instances":[{"id":"white-dragon","package":{"id":"local.dragon","version":"1.0.0"}},{"id":"white-dragon-copy-2","package":{"id":"local.dragon","version":"1.0.0"}},{"id":"copy-pet","package":{"id":"local.copy-pet","version":"1.0.0"}}]}"#
        let value = try PetInstanceRegistry.decode(Data(json.utf8))
        XCTAssertTrue(value.instances[0].autoStartOnLaunch)
        XCTAssertFalse(value.instances[1].autoStartOnLaunch)
        XCTAssertTrue(value.instances[2].autoStartOnLaunch)
    }
    func testInvalidPackageIdentity() {
        for id in ["../outside", "", "UPPER", "/absolute", "local.a\n"] {
            XCTAssertThrowsError(try PetPackageReference(id: id, version: "1.0.0"))
        }
        XCTAssertThrowsError(try PetPackageReference(id: "local.a", version: "../1"))
    }
    func testInvalidPreferences() {
        for p in [PetInstancePreferences(size: 127), .init(size: 385), .init(x: 1), .init(x: .infinity, y: 2), .init(x: .nan, y: 0)] {
            XCTAssertThrowsError(try p.validate())
        }
    }
    func testDuplicateInstanceIDsRejectedButSharedPackageIsAllowed() throws {
        let a = try definition("first")
        XCTAssertThrowsError(try PetInstanceRegistry(instances: [a, a]))
        XCTAssertNoThrow(try PetInstanceRegistry(instances: [a, definition("other", packageID: a.package.id)]))
    }
    func testUnknownSchemaAndOversizedDataRejected() {
        XCTAssertThrowsError(try PetInstanceRegistry.decode(Data(#"{"schemaVersion":2,"instances":[]}"#.utf8)))
        XCTAssertThrowsError(try PetInstanceRegistry.decode(Data(repeating: 32, count: 128 * 1024 + 1)))
    }
    func testDecodedPreferencesAreRevalidated() throws {
        let value = try PetInstanceRegistry(instances: [definition("first")])
        let original = String(data: try JSONEncoder().encode(value), encoding: .utf8)!
        let invalid = original.replacingOccurrences(of: "\"size\":256", with: "\"size\":999")
        XCTAssertThrowsError(try PetInstanceRegistry.decode(Data(invalid.utf8)))
    }
    func testLegacyInstanceSizesAreClampedToFiftyThroughOneHundredFiftyPercent() throws {
        let value = try PetInstanceRegistry(instances: [definition("first")])
        let original = String(data: try JSONEncoder().encode(value), encoding: .utf8)!
        for (old, expected) in [(96, 128), (448, 384), (512, 384)] {
            let legacy = original.replacingOccurrences(of: "\"size\":256", with: "\"size\":\(old)")
            XCTAssertEqual(try PetInstanceRegistry.decode(Data(legacy.utf8)).instances[0].preferences.size, expected)
        }
    }
    func testStartIsIdempotentAndEachPetIndependent() throws {
        var model = try lifecycle()
        let a = try XCTUnwrap(model.start("first"))
        XCTAssertNil(try model.start("first"))
        let b = try XCTUnwrap(model.start("second"))
        XCTAssertTrue(model.ready(a)); XCTAssertTrue(model.ready(b))
        XCTAssertEqual(model.states["first"]?.phase, .running)
        XCTAssertEqual(model.states["second"]?.phase, .running)
    }
    func testStopBeforeReadyInvalidatesOldStart() throws {
        var model = try lifecycle()
        let start = try XCTUnwrap(model.start("first"))
        let stop = try XCTUnwrap(model.stop("first"))
        XCTAssertFalse(model.ready(start)); XCTAssertNil(model.failed(start, message: "stale"))
        XCTAssertThrowsError(try model.start("first"))
        XCTAssertTrue(model.stopped(stop))
        let next = try XCTUnwrap(model.start("first"))
        XCTAssertFalse(model.stopped(stop)); XCTAssertFalse(model.ready(start))
        XCTAssertTrue(model.ready(next))
    }
    func testLocalStopDoesNotStopOtherPet() throws {
        var model = try lifecycle()
        let a = try XCTUnwrap(model.start("first")); let b = try XCTUnwrap(model.start("second"))
        model.ready(a); model.ready(b)
        let stopped = try XCTUnwrap(model.stop("first")); model.stopped(stopped)
        XCTAssertEqual(model.states["second"]?.phase, .running)
        XCTAssertNil(try model.stop("first"))
    }
    func testResourceLimitIncludesStoppingInstances() throws {
        var model = try lifecycle(maximum: 1)
        _ = try model.start("first")
        let stop = try XCTUnwrap(model.stop("first"))
        XCTAssertThrowsError(try model.start("second"))
        model.stopped(stop)
        XCTAssertNotNil(try model.start("second"))
    }
    func testDisabledOrUnknownInstanceCannotStart() throws {
        var model = try PetInstanceLifecycle(registry: .init(instances: [definition("first", enabled: false)]))
        XCTAssertThrowsError(try model.start("first")); XCTAssertThrowsError(try model.start("unknown"))
    }
    func testFailedInstanceCanRetryWithNewGeneration() throws {
        var model = try lifecycle()
        let ticket = try XCTUnwrap(model.start("first"))
        let cleanup = try XCTUnwrap(model.failed(ticket, message: String(repeating: "x", count: 900)))
        XCTAssertEqual(model.states["first"]?.error?.count, 512)
        XCTAssertEqual(model.states["first"]?.phase, .stopping)
        XCTAssertThrowsError(try model.start("first"))
        XCTAssertTrue(model.stopped(cleanup))
        XCTAssertEqual(model.states["first"]?.phase, .failed)
        let next = try XCTUnwrap(model.start("first"))
        XCTAssertNotEqual(ticket.generation, next.generation)
        XCTAssertNil(model.failed(ticket, message: "old failure"))
        XCTAssertTrue(model.ready(next))
    }
    func testShutdownStopsEveryActiveInstanceAndRejectsNewStart() throws {
        var model = try lifecycle()
        _ = try model.start("first"); _ = try model.start("second")
        let stops = model.shutdown()
        XCTAssertEqual(stops.count, 2); XCTAssertTrue(model.shutdown().isEmpty)
        XCTAssertThrowsError(try model.start("first"))
        for stop in stops { XCTAssertTrue(model.stopped(stop)) }
        XCTAssertTrue(model.states.values.allSatisfy { $0.phase == .stopped })
    }
    func testFailureRetainsResourceSlotUntilCleanup() throws {
        var model = try lifecycle(maximum: 1)
        let start = try XCTUnwrap(model.start("first"))
        let cleanup = try XCTUnwrap(model.failed(start, message: "decode error"))
        XCTAssertThrowsError(try model.start("second"))
        XCTAssertFalse(model.ready(start)); XCTAssertFalse(model.stopped(start))
        XCTAssertTrue(model.stopped(cleanup))
        XCTAssertNotNil(try model.start("second"))
    }
    func testSharedExampleRegistry() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let registry = try PetInstanceRegistry.decode(Data(contentsOf: root.appendingPathComponent("config/pet-instances.example.json")))
        XCTAssertEqual(registry.instances.count, 1)
        XCTAssertFalse(registry.instances[0].enabled)
        XCTAssertEqual(registry.instances[0].package.id, "local.bailong.white-dragon")
    }
    func testPreferencesUseValueSemantics() throws {
        var registry = try PetInstanceRegistry(instances: [definition("first"), definition("second")])
        registry.instances[0].preferences.size = 128
        registry.instances[0].preferences.x = -500; registry.instances[0].preferences.y = 100
        XCTAssertEqual(registry.instances[1].preferences.size, 256)
        XCTAssertNil(registry.instances[1].preferences.x)
    }
}
