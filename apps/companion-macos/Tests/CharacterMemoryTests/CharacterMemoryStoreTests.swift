import CharacterCore
import CharacterMemory
import XCTest

final class CharacterMemoryStoreTests: XCTestCase {
    func testIdentityAndMemoryRoundTripAndConfirmation() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let identity = CharacterIdentity(name: "龙妹", personality: "直率", shareWithOnlineModel: true)
        try await store.saveIdentity(identity)

        let candidate = CharacterMemory(kind: .preference, text: "先给方案再实现", source: "语音明确指令")
        try await store.saveMemory(candidate)
        try await store.confirmMemory(id: candidate.id, shareWithOnlineModel: true)

        let loadedIdentity = try await store.loadIdentity(defaultName: "其他")
        XCTAssertEqual(loadedIdentity, identity)
        let loaded = try await store.listMemories()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.status, .confirmed)
        XCTAssertEqual(loaded.first?.text, candidate.text)
        XCTAssertTrue(loaded.first?.shareWithOnlineModel == true)

        let markdown = try String(contentsOf: root.appendingPathComponent("pets/white-dragon/character/identity.md"), encoding: .utf8)
        XCTAssertTrue(markdown.hasPrefix("---\n"))
        XCTAssertTrue(markdown.contains("# 龙妹"))

        let edited = markdown.replacingOccurrences(of: "## 性格\n直率", with: "## 性格\n冷静但直率")
        try edited.write(to: root.appendingPathComponent("pets/white-dragon/character/identity.md"), atomically: true, encoding: .utf8)
        let reloaded = try await store.loadIdentity(defaultName: "其他")
        XCTAssertEqual(reloaded.personality, "冷静但直率")
    }

    func testIdentityNameIsNormalizedBeforeWritingMarkdown() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        try await store.saveIdentity(CharacterIdentity(name: "  龙妹  ", background: "守护桌面"))

        let identity = try await store.loadIdentity(defaultName: "未命名")

        XCTAssertEqual(identity.name, "龙妹")
        XCTAssertEqual(identity.background, "守护桌面")
    }

    func testPetDataIsIsolatedAndDeleteIsHardDelete() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let second = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon-copy")
        let item = CharacterMemory(kind: .fact, text: "only first", source: "test")
        try await first.saveMemory(item)

        let secondMemories = try await second.listMemories()
        XCTAssertTrue(secondMemories.isEmpty)
        try await first.deleteMemory(id: item.id)
        let firstMemories = try await first.listMemories()
        XCTAssertTrue(firstMemories.isEmpty)
    }

    func testMarkdownBodyIsTheMemoryTextSource() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")
        let item = CharacterMemory(kind: .fact, text: "original", source: "test")
        try await store.saveMemory(item)
        let file = root.appendingPathComponent("pets/white-dragon/character/memories/\(item.id).md")
        var markdown = try String(contentsOf: file, encoding: .utf8)
        markdown = markdown.replacingOccurrences(of: "\n\noriginal\n", with: "\n\nchanged in editor\n")
        try markdown.write(to: file, atomically: true, encoding: .utf8)

        let loaded = try await store.listMemories()
        XCTAssertEqual(loaded.first?.text, "changed in editor")
    }

    func testRejectsPetDirectorySymlink() async throws {
        let root = temporaryDirectory()
        let outside = temporaryDirectory()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }
        let pets = root.appendingPathComponent("pets", isDirectory: true)
        try FileManager.default.createDirectory(at: pets, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: pets.appendingPathComponent("white-dragon"), withDestinationURL: outside)
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "white-dragon")

        do {
            _ = try await store.listMemories()
            XCTFail("Expected symbolic-link path to be rejected")
        } catch CharacterMemoryStoreError.unsafePath {
            XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("character").path))
        }
    }

    func testRejectsUnsafePetIdentifier() {
        XCTAssertThrowsError(try CharacterMemoryStore(stateDirectory: temporaryDirectory(), petID: "../outside"))
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }
}
