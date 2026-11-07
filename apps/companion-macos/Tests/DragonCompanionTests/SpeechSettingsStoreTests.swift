import Foundation
import XCTest
@testable import DragonCompanion

final class SpeechSettingsStoreTests: XCTestCase {
    func testMissingSettingsLoadsSafeDisabledDefaults() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let settings = try SpeechSettingsStore(stateDirectory: root).load()
        XCTAssertEqual(settings, SpeechSettings())
        XCTAssertTrue(settings.displayReplies)
        XCTAssertFalse(settings.speakReplies)
        XCTAssertTrue(settings.referenceAudioPath.isEmpty)
    }

    func testSaveRoundTripsAndRestrictsFilePermissions() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SpeechSettingsStore(stateDirectory: root)
        var settings = SpeechSettings()
        settings.platform = "douyin"
        settings.roomIdentifier = "123456"
        settings.referenceAudioPath = "/Users/test/voice.wav"
        settings.referenceAudioBookmark = Data([1, 2, 3, 4])
        settings.referenceTranscript = "准确转写内容"
        settings.microphoneUID = "BuiltInMicrophoneDevice"
        settings.speakReplies = false

        try store.save(settings)

        XCTAssertEqual(try store.load(), settings)
        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testLegacySettingsWithoutBookmarkOrTranscriptStillLoads() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = Data("""
        {"schemaVersion":1,"platform":"bilibili","roomIdentifier":"","referenceAudioPath":"/tmp/old.wav","displayReplies":true,"speakReplies":true}
        """.utf8)
        try legacy.write(to: SpeechSettingsStore(stateDirectory: root).fileURL)
        let settings = try SpeechSettingsStore(stateDirectory: root).load()
        XCTAssertEqual(settings.referenceAudioPath, "/tmp/old.wav")
        XCTAssertNil(settings.referenceAudioBookmark)
        XCTAssertTrue(settings.referenceTranscript.isEmpty)
        XCTAssertFalse(settings.speakReplies)
        XCTAssertNil(settings.microphoneUID)
    }

    func testLegacySettingsWithoutMicrophoneSelectionRemainCompatible() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = Data("""
        {"schemaVersion":1,"platform":"bilibili","roomIdentifier":"","referenceAudioPath":"","displayReplies":true,"speakReplies":false}
        """.utf8)
        try legacy.write(to: SpeechSettingsStore(stateDirectory: root).fileURL)

        XCTAssertNil(try SpeechSettingsStore(stateDirectory: root).load().microphoneUID)
    }

    func testRejectsUnknownPlatformAndControlCharacters() {
        var settings = SpeechSettings()
        settings.platform = "unknown"
        XCTAssertThrowsError(try settings.validate())
        settings = SpeechSettings()
        settings.roomIdentifier = "room\nsecret"
        XCTAssertThrowsError(try settings.validate())
    }

    func testRejectsSymlinkedSettingsFile() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SpeechSettingsStore(stateDirectory: root)
        let target = root.appendingPathComponent("outside.json")
        try JSONEncoder().encode(SpeechSettings()).write(to: target)
        try FileManager.default.createSymbolicLink(at: store.fileURL, withDestinationURL: target)

        XCTAssertThrowsError(try store.load())
    }

    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("speech-settings-" + UUID().uuidString)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
