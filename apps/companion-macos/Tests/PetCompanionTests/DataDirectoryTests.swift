import Foundation
import XCTest
@testable import PetCompanion

final class DataDirectoryTests: XCTestCase {
    private func temporaryHome() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("data-directory-" + UUID().uuidString)
    }

    func testCreatesOnlyProductDirectoryWithoutCompatibilityLink() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let result = try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home)
        XCTAssertEqual(result.lastPathComponent, "AnimeDesktopPets")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: result.deletingLastPathComponent().path), ["AnimeDesktopPets"])
    }

    func testLeavesOldDirectoryAndContentsUntouched() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let legacy = home.appendingPathComponent("Library/Application Support/" + "Dragon" + "CodexCompanion")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: legacy.appendingPathComponent("companion.json"))
        let result = try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home)
        XCTAssertFalse(FileManager.default.fileExists(atPath: result.appendingPathComponent("companion.json").path))
        XCTAssertEqual(try String(contentsOf: legacy.appendingPathComponent("companion.json"), encoding: .utf8), "keep")
        XCTAssertThrowsError(try FileManager.default.destinationOfSymbolicLink(atPath: legacy.path))
    }

    func testExistingProductDirectoryDoesNotConflictWithOldDirectory() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let support = home.appendingPathComponent("Library/Application Support")
        let current = support.appendingPathComponent("AnimeDesktopPets")
        let legacy = support.appendingPathComponent("Dragon" + "CodexCompanion")
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        XCTAssertEqual(try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home).path, current.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
    }

    func testRefusesProductDirectoryFileOrSymlinkWithoutTouchingTarget() throws {
        for symlink in [false, true] {
            let home = temporaryHome()
            defer { try? FileManager.default.removeItem(at: home) }
            let support = home.appendingPathComponent("Library/Application Support")
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            let current = support.appendingPathComponent("AnimeDesktopPets")
            let target = home.appendingPathComponent("keep")
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            if symlink {
                try FileManager.default.createSymbolicLink(at: current, withDestinationURL: target)
            } else {
                try Data("keep".utf8).write(to: current)
            }
            XCTAssertThrowsError(try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home))
            XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
        }
    }

    func testExplicitProductOverrideDoesNotCreateDefaultDirectory() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let override = home.appendingPathComponent("isolated")
        XCTAssertEqual(try Runtime.resolveStateDirectory(environment: ["PET_DATA_DIR": override.path], homeDirectory: home), override)
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support").path))
    }

    func testOldEnvironmentVariableIsIgnored() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let override = home.appendingPathComponent("ignored")
        let result = try Runtime.resolveStateDirectory(environment: ["DRAGON" + "_DATA_DIR": override.path], homeDirectory: home)
        XCTAssertEqual(result.lastPathComponent, "AnimeDesktopPets")
        XCTAssertFalse(FileManager.default.fileExists(atPath: override.path))
    }
}
