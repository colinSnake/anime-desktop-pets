import Darwin
import Foundation

struct SpeechSettings: Codable, Equatable, Sendable {
    var schemaVersion = 1
    var platform = "bilibili"
    var roomIdentifier = ""
    var referenceAudioPath = ""
    var referenceAudioBookmark: Data?
    var referenceTranscript = ""
    var microphoneUID: String?
    var displayReplies = true
    var speakReplies = false

    init() {}

    func validate() throws {
        guard schemaVersion == 1 else { throw StoreError.invalidSettings }
        guard ["bilibili", "douyin"].contains(platform) else { throw StoreError.invalidSettings }
        guard roomIdentifier.utf8.count <= 256,
              referenceAudioPath.utf8.count <= 4096,
              referenceTranscript.utf8.count <= 4096,
              (microphoneUID?.utf8.count ?? 0) <= 1024 else { throw StoreError.invalidSettings }
        guard !roomIdentifier.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw StoreError.invalidSettings
        }
    }

    enum StoreError: LocalizedError {
        case invalidSettings
        case unsafeFile
        case fileTooLarge

        var errorDescription: String? {
            switch self {
            case .invalidSettings: "语音设置格式无效；未保存。"
            case .unsafeFile: "语音设置不是普通文件；为保护数据，拒绝读取。"
            case .fileTooLarge: "语音设置文件超过64KiB；为保护数据，拒绝读取。"
            }
        }
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, platform, roomIdentifier, referenceAudioPath, referenceAudioBookmark
        case referenceTranscript, microphoneUID, displayReplies, speakReplies
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        platform = try values.decodeIfPresent(String.self, forKey: .platform) ?? "bilibili"
        roomIdentifier = try values.decodeIfPresent(String.self, forKey: .roomIdentifier) ?? ""
        referenceAudioPath = try values.decodeIfPresent(String.self, forKey: .referenceAudioPath) ?? ""
        referenceAudioBookmark = try values.decodeIfPresent(Data.self, forKey: .referenceAudioBookmark)
        referenceTranscript = try values.decodeIfPresent(String.self, forKey: .referenceTranscript) ?? ""
        microphoneUID = try values.decodeIfPresent(String.self, forKey: .microphoneUID)
        displayReplies = try values.decodeIfPresent(Bool.self, forKey: .displayReplies) ?? true
        speakReplies = referenceAudioBookmark == nil
            ? false
            : (try values.decodeIfPresent(Bool.self, forKey: .speakReplies) ?? false)
    }
}

struct SpeechSettingsStore {
    let fileURL: URL

    init(stateDirectory: URL) {
        fileURL = stateDirectory.appendingPathComponent("speech-settings.json")
    }

    func load() throws -> SpeechSettings {
        var info = stat()
        guard lstat(fileURL.path, &info) == 0 else {
            if errno == ENOENT { return SpeechSettings() }
            throw SpeechSettings.StoreError.unsafeFile
        }
        guard (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG) else {
            throw SpeechSettings.StoreError.unsafeFile
        }
        guard info.st_size <= 64 * 1024 else { throw SpeechSettings.StoreError.fileTooLarge }
        let settings = try JSONDecoder().decode(SpeechSettings.self, from: Data(contentsOf: fileURL))
        try settings.validate()
        return settings
    }

    func save(_ settings: SpeechSettings) throws {
        try settings.validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(settings).write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}
