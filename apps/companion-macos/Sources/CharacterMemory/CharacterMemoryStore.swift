import CharacterCore
import Darwin
import Foundation

public enum CharacterMemoryStoreError: LocalizedError {
    case invalidPetID
    case invalidRecord
    case unsafePath

    public var errorDescription: String? {
        switch self {
        case .invalidPetID: "桌宠实例标识无效。"
        case .invalidRecord: "角色资料格式无效或版本不兼容。"
        case .unsafePath: "角色资料路径不是普通文件或目录，已停止操作以保护数据。"
        }
    }
}

public actor CharacterMemoryStore {
    private let stateDirectory: URL
    private let petID: String
    private let fileManager: FileManager

    public init(stateDirectory: URL, petID: String, fileManager: FileManager = .default) throws {
        guard petID.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else {
            throw CharacterMemoryStoreError.invalidPetID
        }
        self.stateDirectory = stateDirectory.standardizedFileURL
        self.petID = petID
        self.fileManager = fileManager
    }

    public func loadIdentity(defaultName: String) throws -> CharacterIdentity {
        try prepareDirectories()
        let url = characterDirectory.appendingPathComponent("identity.md")
        guard fileExists(url) else { return .starter(name: defaultName) }
        guard isRegularFile(url) else { throw CharacterMemoryStoreError.unsafePath }
        return try CharacterMarkdownCodec.decodeIdentity(Data(contentsOf: url))
    }

    public func saveIdentity(_ identity: CharacterIdentity) throws {
        try prepareDirectories()
        let name = identity.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = [identity.role, identity.background, identity.personality, identity.values,
                      identity.motivations, identity.relationship, identity.speakingStyle,
                      identity.knowledgeScope, identity.boundaries]
        guard !name.isEmpty, name.count <= 80, !name.contains("\n"), !name.contains("\r"),
              fields.allSatisfy({ $0.count <= 2_000 }), fields.reduce(name.count, { $0 + $1.count }) <= 8_000 else {
            throw CharacterMemoryStoreError.invalidRecord
        }
        var normalized = identity
        normalized.name = name
        try write(CharacterMarkdownCodec.encode(identity: normalized),
                  to: characterDirectory.appendingPathComponent("identity.md"))
    }

    public func listMemories() throws -> [CharacterMemory] {
        try prepareDirectories()
        let urls = try fileManager.contentsOfDirectory(at: memoriesDirectory,
                                                       includingPropertiesForKeys: nil,
                                                       options: [.skipsHiddenFiles])
        return try urls.filter { $0.pathExtension == "md" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { try readMemory(from: $0) }
    }

    public func saveMemory(_ memory: CharacterMemory) throws {
        try prepareDirectories()
        guard memory.id.range(of: "^[A-Fa-f0-9-]{16,64}$", options: .regularExpression) != nil,
              !memory.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              memory.text.count <= 1_000 else { throw CharacterMemoryStoreError.invalidRecord }
        try write(CharacterMarkdownCodec.encode(memory: memory), to: memoryURL(memory.id))
    }

    public func confirmMemory(id: String, shareWithOnlineModel: Bool? = nil) throws {
        var memory = try readMemory(from: existingMemoryURL(id))
        memory.status = .confirmed
        if let shareWithOnlineModel { memory.shareWithOnlineModel = shareWithOnlineModel }
        try saveMemory(memory)
    }

    public func confirmMemory(_ memory: CharacterMemory) throws {
        var confirmed = memory
        confirmed.status = .confirmed
        try saveMemory(confirmed)
    }

    public func deleteMemory(id: String) throws {
        let url = try existingMemoryURL(id)
        guard isRegularFile(url) else { throw CharacterMemoryStoreError.unsafePath }
        try fileManager.removeItem(at: url)
    }

    private var characterDirectory: URL {
        stateDirectory.appendingPathComponent("pets", isDirectory: true)
            .appendingPathComponent(petID, isDirectory: true)
            .appendingPathComponent("character", isDirectory: true)
    }

    private var memoriesDirectory: URL { characterDirectory.appendingPathComponent("memories", isDirectory: true) }
    private var plansDirectory: URL { characterDirectory.appendingPathComponent("plans", isDirectory: true) }

    public func listGoals() throws -> [CharacterGoal] {
        try prepareDirectories()
        let urls = try fileManager.contentsOfDirectory(at: plansDirectory, includingPropertiesForKeys: nil,
                                                       options: [.skipsHiddenFiles])
        return try urls.filter { $0.pathExtension == "md" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { url in
                guard isRegularFile(url) else { throw CharacterMemoryStoreError.unsafePath }
                return try CharacterMarkdownCodec.decodeGoal(Data(contentsOf: url), expectedID: url.deletingPathExtension().lastPathComponent)
            }
    }

    public func saveGoal(_ goal: CharacterGoal) throws {
        try prepareDirectories()
        guard CharacterGoalValidation.validate(goal) else { throw CharacterMemoryStoreError.invalidRecord }
        try write(CharacterMarkdownCodec.encode(goal: goal), to: planURL(goal.id))
    }

    public func deleteGoal(id: String) throws {
        guard CharacterGoalValidation.isSafeIdentifier(id) else { throw CharacterMemoryStoreError.invalidRecord }
        try prepareDirectories()
        let url = planURL(id)
        guard isRegularFile(url) else { throw CharacterMemoryStoreError.unsafePath }
        try fileManager.removeItem(at: url)
    }

    private func prepareDirectories() throws {
        var rootInfo = stat()
        if lstat(stateDirectory.path, &rootInfo) == 0 {
            guard rootInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { throw CharacterMemoryStoreError.unsafePath }
        } else if errno == ENOENT {
            try fileManager.createDirectory(at: stateDirectory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
        } else {
            throw CharacterMemoryStoreError.unsafePath
        }
        let petsDirectory = stateDirectory.appendingPathComponent("pets", isDirectory: true)
        let directories = [petsDirectory, petsDirectory.appendingPathComponent(petID, isDirectory: true),
                           characterDirectory, memoriesDirectory, plansDirectory]
        for directory in directories {
            var info = stat()
            if lstat(directory.path, &info) == 0 {
                guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { throw CharacterMemoryStoreError.unsafePath }
            } else if errno == ENOENT {
                try fileManager.createDirectory(at: directory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
            } else {
                throw CharacterMemoryStoreError.unsafePath
            }
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
    }

    private func write(_ data: Data, to url: URL) throws {
        if fileExists(url), !isRegularFile(url) { throw CharacterMemoryStoreError.unsafePath }
        try data.write(to: url, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func readMemory(from url: URL) throws -> CharacterMemory {
        guard isRegularFile(url) else { throw CharacterMemoryStoreError.unsafePath }
        return try CharacterMarkdownCodec.decodeMemory(
            Data(contentsOf: url), expectedID: url.deletingPathExtension().lastPathComponent
        )
    }

    private func existingMemoryURL(_ id: String) throws -> URL {
        guard id.range(of: "^[A-Fa-f0-9-]{16,64}$", options: .regularExpression) != nil else {
            throw CharacterMemoryStoreError.invalidRecord
        }
        try prepareDirectories()
        let url = memoryURL(id)
        guard fileExists(url) else { throw CocoaError(.fileNoSuchFile) }
        return url
    }

    private func memoryURL(_ id: String) -> URL { memoriesDirectory.appendingPathComponent("\(id).md") }
    private func planURL(_ id: String) -> URL { plansDirectory.appendingPathComponent("\(id).md") }

    private func fileExists(_ url: URL) -> Bool {
        var info = stat()
        return lstat(url.path, &info) == 0
    }

    private func isRegularFile(_ url: URL) -> Bool {
        var info = stat()
        return lstat(url.path, &info) == 0 && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
    }
}
