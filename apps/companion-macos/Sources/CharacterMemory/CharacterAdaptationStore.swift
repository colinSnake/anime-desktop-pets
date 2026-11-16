import CharacterCore
import Foundation

/// One process-lifetime session per canonical character directory. The registry lock
/// only protects lookup; unrelated pets never share a filesystem transaction lock.
private final class CharacterAdaptationSessions: @unchecked Sendable {
    static let shared = CharacterAdaptationSessions()
    private let lock = NSLock()
    private var sessions: [String: CharacterAdaptationSession] = [:]

    func session(for path: String) -> CharacterAdaptationSession {
        lock.lock()
        defer { lock.unlock() }
        if let session = sessions[path] { return session }
        let session = CharacterAdaptationSession()
        sessions[path] = session
        return session
    }
}

/// All mutable fields are accessed under this recursive lock, never across an await.
/// Sessions outlive windows/store actors so failed revocations cannot be forgotten.
final class CharacterAdaptationSession: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    var epoch = UUID()
    var denyLearning = false
    var denySharing = false
    var learningChange: UUID?
    var sharingChange: UUID?
    private var saveFailure: String?

    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func begin(_ operation: CharacterAdaptationOperation) -> UUID {
        epoch = UUID()
        switch operation {
        case .enabled(let enabled):
            learningChange = epoch
            if !enabled { denyLearning = true }
        case .sharing(let enabled):
            sharingChange = epoch
            if !enabled { denySharing = true }
        case .reset, .rollback: break
        }
        return epoch
    }

    func failedSave(_ error: Error) {
        denyLearning = true
        denySharing = true
        epoch = UUID()
        saveFailure = error.localizedDescription
    }

    func completed(_ operation: CharacterAdaptationOperation, token: UUID) {
        switch operation {
        case .enabled(true) where learningChange == token: denyLearning = false
        case .sharing(true) where sharingChange == token: denySharing = false
        default: break
        }
        if !denyLearning && !denySharing { saveFailure = nil }
    }

    var warning: String? {
        guard let saveFailure, denyLearning || denySharing else { return nil }
        let blocked = [denyLearning ? "学习" : nil, denySharing ? "在线分享" : nil].compactMap { $0 }.joined(separator: "和")
        return "此前适应设置未保存：\(saveFailure) 本次运行仍暂停\(blocked)；需明确开启对应开关并保存成功后恢复。"
    }

    func applyingDenials(to state: CharacterAdaptationState) -> CharacterAdaptationState {
        var copy = state
        if denyLearning { copy.enabled = false }
        if denySharing { copy.shareWithOnlineModel = false }
        return copy
    }

    func snapshot(_ state: CharacterAdaptationState) -> CharacterAdaptationState {
        let issuedEpoch = epoch
        return applyingDenials(to: state).withSessionAuthorization { [self] in
            withLock {
                (learning: !denyLearning && epoch == issuedEpoch,
                 sharing: !denySharing && epoch == issuedEpoch)
            }
        }
    }
}

extension CharacterMemoryStore {
    private static let adaptationFileLimit = 64 * 1024

    nonisolated var adaptationSession: CharacterAdaptationSession {
        CharacterAdaptationSessions.shared.session(for: characterDirectory.resolvingSymlinksInPath().path)
    }

    /// Capture before starting a logical chat turn, not when its reply arrives.
    public nonisolated var adaptationEpoch: UUID {
        let session = adaptationSession
        return session.withLock { session.epoch }
    }

    /// Revoke synchronously before queueing persistence; only a successful explicit
    /// enable/share operation can clear its respective deny bit.
    @discardableResult
    public nonisolated func beginAdaptationOperation(_ operation: CharacterAdaptationOperation) -> UUID {
        let session = adaptationSession
        return session.withLock { session.begin(operation) }
    }

    public nonisolated var adaptationSessionWarning: String? {
        let session = adaptationSession
        return session.withLock { session.warning }
    }

    /// Separate store actors for the same character share the complete transaction.
    @discardableResult
    public func observeAdaptation(_ turn: CharacterChatTurn, epoch: UUID? = nil) throws -> CharacterAdaptationState {
        let session = adaptationSession
        return try session.withLock {
            let loaded = try readAdaptationRecord()
            guard epoch == nil || epoch == session.epoch else { return session.snapshot(loaded) }
            var state = session.applyingDenials(to: loaded)
            if state.observe(turn) { try writeAdaptationRecord(state) }
            return session.snapshot(state)
        }
    }

    /// Missing state opts into local learning only. Corrupt or unsafe files throw without replacing data.
    public func loadAdaptation() throws -> CharacterAdaptationState {
        let session = adaptationSession
        return try session.withLock { session.snapshot(try readAdaptationRecord()) }
    }

    /// Plain saves cannot restore a denied authorization. They also invalidate
    /// outstanding turns, including legacy callers saving a locally reset state.
    public func saveAdaptation(_ state: CharacterAdaptationState) throws {
        let session = adaptationSession
        try session.withLock {
            do {
                try writeAdaptationRecord(session.applyingDenials(to: state))
                session.epoch = UUID()
            } catch {
                session.failedSave(error)
                throw error
            }
        }
    }

    // Caller must hold adaptationSession's lock for the entire transaction.
    func readAdaptationRecord() throws -> CharacterAdaptationState {
        try prepareDirectories()
        let url = characterDirectory.appendingPathComponent("adaptation.json")
        guard fileExists(url) else { return .init() }
        guard isRegularFile(url) else { throw CharacterMemoryStoreError.unsafePath }
        let data = try readData(from: url, limit: Self.adaptationFileLimit)
        do { return try JSONDecoder().decode(CharacterAdaptationState.self, from: data) }
        catch { throw CharacterMemoryStoreError.invalidRecord }
    }

    func writeAdaptationRecord(_ state: CharacterAdaptationState) throws {
        try prepareDirectories()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(state)
        guard data.count <= Self.adaptationFileLimit else { throw CharacterMemoryStoreError.invalidRecord }
        try write(data, to: characterDirectory.appendingPathComponent("adaptation.json"))
    }
}
