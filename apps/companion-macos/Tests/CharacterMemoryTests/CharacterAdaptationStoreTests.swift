import CharacterCore
import CharacterMemory
import Darwin
import Foundation
import XCTest

final class CharacterAdaptationStoreTests: XCTestCase {
    private func root() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("adaptation-\(UUID().uuidString)", isDirectory: true)
    }

    private func file(_ root: URL, petID: String = "test-pet") -> URL {
        root.appendingPathComponent("pets/\(petID)/character/adaptation.json")
    }

    func testAdaptationMissingFileReturnsLocalLearningWithoutWritingIdentity() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        let state = try await store.loadAdaptation()
        XCTAssertEqual(state, CharacterAdaptationState())
        XCTAssertFalse(FileManager.default.fileExists(atPath: file(root).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file(root).deletingLastPathComponent().appendingPathComponent("identity.md").path))
    }

    func testAdaptationRoundTripPreservesEvidenceConsentAndStableIdentityAcrossStoreInstances() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        var identity = CharacterIdentity.starter(name: "龙妹")
        identity.values = "稳定价值观"
        try await store.saveIdentity(identity)
        let identityURL = file(root).deletingLastPathComponent().appendingPathComponent("identity.md")
        let identityBytes = try Data(contentsOf: identityURL)
        var state = CharacterAdaptationState()
        XCTAssertTrue(state.observe(.init(role: .user, text: "请简短一点")))
        state.shareWithOnlineModel = true
        try await store.saveAdaptation(state)
        let reopened = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        let loaded = try await reopened.loadAdaptation()
        XCTAssertEqual(loaded, state)
        XCTAssertEqual(try Data(contentsOf: identityURL), identityBytes)
        let other = try CharacterMemoryStore(stateDirectory: root, petID: "another-pet")
        let otherState = try await other.loadAdaptation()
        XCTAssertEqual(otherState, CharacterAdaptationState())
        let permissions = try FileManager.default.attributesOfItem(atPath: file(root).path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    func testAdaptationPersistenceKeepsOneBoundedFileAndPersistsRollbackAndReset() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        var state = CharacterAdaptationState()
        for i in 0..<80 {
            XCTAssertTrue(state.observe(.init(role: .user, text: i.isMultiple(of: 2) ? "请简短一点" : "请详细一点")))
            try await store.saveAdaptation(state)
        }
        XCTAssertLessThanOrEqual(try Data(contentsOf: file(root)).count, 64 * 1024)
        let files = try FileManager.default.contentsOfDirectory(atPath: file(root).deletingLastPathComponent().path)
        XCTAssertEqual(files.filter { $0.hasPrefix("adaptation") }, ["adaptation.json"])
        var loaded = try await store.loadAdaptation()
        XCTAssertEqual(loaded.history.count, 30)
        XCTAssertTrue(loaded.rollback())
        try await store.saveAdaptation(loaded)
        let rolledBack = try await store.loadAdaptation()
        XCTAssertEqual(rolledBack.revision, 81)
        loaded.reset()
        try await store.saveAdaptation(loaded)
        let reset = try await store.loadAdaptation()
        XCTAssertEqual(reset.revision, 82)
        XCTAssertEqual(reset.verbosity, 0)
        XCTAssertFalse(reset.shareWithOnlineModel)
    }

    func testAdaptationActorObservationIsAtomicAndDuplicateFeedbackDoesNotWrite() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        let learned = try await store.observeAdaptation(.init(role: .user, text: "请简短一点"))
        XCTAssertEqual(learned.verbosity, -1)
        let marker = Date(timeIntervalSince1970: 1_700_000_000)
        try FileManager.default.setAttributes([.modificationDate: marker], ofItemAtPath: file(root).path)
        let duplicate = try await store.observeAdaptation(.init(role: .user, text: "请简短一点"))
        XCTAssertEqual(duplicate, learned)
        let modification = try FileManager.default.attributesOfItem(atPath: file(root).path)[.modificationDate] as? Date
        XCTAssertEqual(modification, marker)
        var disabled = learned
        disabled.enabled = false
        try await store.saveAdaptation(disabled)
        let ignored = try await store.observeAdaptation(.init(role: .user, text: "请活泼一点"))
        XCTAssertEqual(ignored, disabled)
    }

    func testAdaptationConcurrentObservationsDoNotLoseIndependentDimensions() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        async let concise = store.observeAdaptation(.init(role: .user, text: "请简短一点"))
        async let playful = store.observeAdaptation(.init(role: .user, text: "请活泼一点"))
        _ = try await (concise, playful)
        let loaded = try await store.loadAdaptation()
        XCTAssertEqual(loaded.verbosity, -1)
        XCTAssertEqual(loaded.playfulness, 1)
        XCTAssertEqual(loaded.revision, 2)
    }

    func testAdaptationRejectsMalformedOversizedAndDirectoryInputsWithoutReplacingThem() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        _ = try await store.loadAdaptation()
        for bytes in [Data("{bad".utf8), Data("{}".utf8), Data(repeating: 32, count: 64 * 1024 + 1)] {
            try bytes.write(to: file(root))
            do { _ = try await store.loadAdaptation(); XCTFail("Unsafe state must not become enabled/shared defaults") }
            catch { }
            XCTAssertEqual(try Data(contentsOf: file(root)), bytes)
        }
        try FileManager.default.removeItem(at: file(root))
        try FileManager.default.createDirectory(at: file(root), withIntermediateDirectories: false)
        do { _ = try await store.loadAdaptation(); XCTFail("Directory must be rejected") } catch { }
        do { try await store.saveAdaptation(.init()); XCTFail("Directory must not be replaced") } catch { }
    }

    func testAdaptationRejectsSymlinkFilesIncludingDanglingLinksAndFIFOs() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        _ = try await store.loadAdaptation()
        let external = root.appendingPathComponent("untouched.json")
        let marker = Data("private data".utf8)
        try marker.write(to: external)
        for destination in [external, root.appendingPathComponent("missing.json")] {
            try FileManager.default.createSymbolicLink(at: file(root), withDestinationURL: destination)
            do { _ = try await store.loadAdaptation(); XCTFail("Symlink must be rejected") } catch { }
            do { try await store.saveAdaptation(.init()); XCTFail("Symlink must not be replaced") } catch { }
            XCTAssertEqual(try Data(contentsOf: external), marker)
            try FileManager.default.removeItem(at: file(root))
        }
        XCTAssertEqual(mkfifo(file(root).path, 0o600), 0)
        do { _ = try await store.loadAdaptation(); XCTFail("FIFO must not block or be read") } catch { }
        do { try await store.saveAdaptation(.init()); XCTFail("FIFO must not be replaced") } catch { }
    }

    func testAdaptationRejectsSymlinkCharacterDirectory() async throws {
        let root = root()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "test-pet")
        _ = try await store.loadAdaptation()
        let directory = file(root).deletingLastPathComponent()
        let moved = root.appendingPathComponent("other-character")
        try FileManager.default.moveItem(at: directory, to: moved)
        try FileManager.default.createSymbolicLink(at: directory, withDestinationURL: moved)
        do { _ = try await store.loadAdaptation(); XCTFail("Symlink directory must be rejected") } catch { }
        do { try await store.saveAdaptation(.init()); XCTFail("Symlink directory must not be written") } catch { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: moved.appendingPathComponent("adaptation.json").path))
    }
}
