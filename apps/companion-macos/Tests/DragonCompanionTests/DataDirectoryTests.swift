import Foundation
import XCTest
@testable import DragonCompanion

final class DataDirectoryTests: XCTestCase {
    func testMigratesLegacyDirectoryAndLeavesCompatibilitySymlink() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("data-directory-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let support = home.appendingPathComponent("Library/Application Support")
        let legacy = support.appendingPathComponent("DragonCodexCompanion")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: legacy.appendingPathComponent("companion.json"))

        let result = try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home)
        XCTAssertEqual(result.lastPathComponent, "AnimeDesktopPets")
        XCTAssertEqual(try String(contentsOf: result.appendingPathComponent("companion.json"), encoding: .utf8), "keep")
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: legacy.path), "AnimeDesktopPets")
    }

    func testRefusesToMergeWhenBothDirectoryNamesExist() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("data-directory-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let support = home.appendingPathComponent("Library/Application Support")
        let current = support.appendingPathComponent("AnimeDesktopPets")
        let legacy = support.appendingPathComponent("DragonCodexCompanion")
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)

        XCTAssertThrowsError(try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home))
        XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
    }

    func testDoesNotMoveDirectoryWhileLegacyHostLockIsHeld() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("data-directory-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let legacy = home.appendingPathComponent("Library/Application Support/DragonCodexCompanion")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        let lockURL = legacy.appendingPathComponent("instance.lock")
        FileManager.default.createFile(atPath: lockURL.path, contents: Data())
        let lock = try InstanceLock(url: lockURL)
        defer { _ = lock }

        XCTAssertThrowsError(try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/AnimeDesktopPets").path))
    }

    func testRefusesLegacyFileOrUnexpectedDirectorySymlink() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("data-directory-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let support = home.appendingPathComponent("Library/Application Support")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let legacy = support.appendingPathComponent("DragonCodexCompanion")
        try Data("keep".utf8).write(to: legacy)

        XCTAssertThrowsError(try Runtime.resolveStateDirectory(environment: [:], homeDirectory: home))
        XCTAssertEqual(try String(contentsOf: legacy, encoding: .utf8), "keep")
        XCTAssertFalse(FileManager.default.fileExists(atPath: support.appendingPathComponent("AnimeDesktopPets").path))
    }

    func testExplicitDataDirectoryOverrideSkipsDefaultMigration() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("data-directory-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let override = home.appendingPathComponent("isolated")
        let result = try Runtime.resolveStateDirectory(environment: ["DRAGON_DATA_DIR": override.path], homeDirectory: home)
        XCTAssertEqual(result, override.standardizedFileURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support").path))
    }
}
