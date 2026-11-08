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
        XCTAssertFalse(settings.speakInteractiveBubbles)
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
        settings.speakInteractiveBubbles = true

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
        XCTAssertFalse(settings.speakInteractiveBubbles)
        XCTAssertNil(settings.microphoneUID)
    }

    func testInteractiveBubbleSpeechIsIndependentFromReplySpeech() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SpeechSettingsStore(stateDirectory: root)
        var settings = SpeechSettings()
        settings.referenceAudioPath = "/Users/test/voice.wav"
        settings.referenceAudioBookmark = Data([1, 2, 3, 4])
        settings.referenceTranscript = "准确转写内容"
        settings.speakReplies = true
        settings.speakInteractiveBubbles = false

        try store.save(settings)
        let loaded = try store.load()

        XCTAssertTrue(loaded.speakReplies)
        XCTAssertFalse(loaded.speakInteractiveBubbles)
    }

    func testInteractiveBubbleToggleChangesOnlyItsOwnPreference() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SpeechSettingsStore(stateDirectory: root)
        var settings = SpeechSettings()
        settings.referenceAudioPath = "/Users/test/voice.wav"
        settings.referenceAudioBookmark = Data([1, 2, 3, 4])
        settings.referenceTranscript = "准确转写内容"
        settings.speakReplies = true
        try store.save(settings)

        let enabled = try store.toggleInteractiveBubbleSpeech()
        XCTAssertTrue(enabled.speakInteractiveBubbles)
        XCTAssertTrue(enabled.speakReplies)
        XCTAssertEqual(try store.load(), enabled)

        let disabled = try store.toggleInteractiveBubbleSpeech()
        XCTAssertFalse(disabled.speakInteractiveBubbles)
        XCTAssertTrue(disabled.speakReplies)
    }

    func testInteractiveBubbleToggleRequiresReferenceAndDoesNotWriteOnRejection() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SpeechSettingsStore(stateDirectory: root)

        XCTAssertThrowsError(try store.toggleInteractiveBubbleSpeech()) { error in
            XCTAssertEqual(error as? SpeechSettings.StoreError, .missingInteractiveSpeechReference)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
        var disabled = SpeechSettings()
        disabled.referenceAudioPath = "/Users/test/voice.wav"
        disabled.referenceAudioBookmark = Data([1, 2, 3, 4])
        disabled.referenceTranscript = "准确转写内容"
        try store.save(disabled)
        XCTAssertTrue(try store.toggleInteractiveBubbleSpeech().speakInteractiveBubbles)
        XCTAssertFalse(try store.toggleInteractiveBubbleSpeech().speakInteractiveBubbles)
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

    func testLegacyInteractiveSpeechDoesNotInheritReplySpeechPreference() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = Data("""
        {"schemaVersion":1,"platform":"bilibili","roomIdentifier":"","referenceAudioPath":"/tmp/voice.wav","referenceAudioBookmark":"AQID","referenceTranscript":"准确转写","displayReplies":true,"speakReplies":true}
        """.utf8)
        try legacy.write(to: SpeechSettingsStore(stateDirectory: root).fileURL)

        let settings = try SpeechSettingsStore(stateDirectory: root).load()
        XCTAssertTrue(settings.speakReplies)
        XCTAssertFalse(settings.speakInteractiveBubbles)
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
