import Foundation
import XCTest
@testable import PetCompanion

final class SpeechRuntimeLocationTests: XCTestCase {
    func testFinderLaunchResolvesBuildTimeRepositoryWithoutEnvironment() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let resources = dir.appendingPathComponent("桌边小崽.app/Contents/Resources")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let repository = dir.appendingPathComponent("本机源码 checkout")
        try JSONEncoder().encode(repository.path).write(to: resources.appendingPathComponent("speech-development-root.json"))
        XCTAssertEqual(Runtime.resolveSpeechRepository(resources: resources, environment: [:]), repository)
    }

    func testExplicitDevelopmentRootOverridesBundledHint() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try JSONEncoder().encode("/different-checkout").write(to: dir.appendingPathComponent("speech-development-root.json"))
        XCTAssertEqual(Runtime.resolveSpeechRepository(resources: dir, environment: ["PET_DEV_ROOT": "/explicit-checkout"]),
                       URL(fileURLWithPath: "/explicit-checkout"))
    }

    func testInvalidOrOversizedHintsCannotSelectExecutableRoot() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for value in ["relative-checkout", "", "https://example.invalid/code", "/tmp/" + String(repeating: "x", count: 5_000)] {
            try JSONEncoder().encode(value).write(to: dir.appendingPathComponent("speech-development-root.json"))
            XCTAssertEqual(Runtime.resolveSpeechRepository(resources: dir, environment: [:]), dir.deletingLastPathComponent())
        }
    }

    func testSourceLaunchWithoutHintRetainsResourceParentFallback() {
        XCTAssertEqual(Runtime.resolveSpeechRepository(resources: URL(fileURLWithPath: "/fixture/resources"), environment: [:]).path,
                       "/fixture")
    }
}
