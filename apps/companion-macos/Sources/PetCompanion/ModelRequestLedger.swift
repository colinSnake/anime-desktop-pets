import Darwin
import Foundation

/// A lifetime (not daily) budget for the explicitly authorized synthetic acceptance run.
/// Main must reuse ONE URL for memory, reply, speech and bubble calls. Never put user
/// content in purpose. There is deliberately no reset, refund, configurable cap or retry.
/// Keep both the ledger and its `.lock` file; removing a ledger alone fails closed.
final class ModelRequestLedger: @unchecked Sendable {
    static let maximumAttempts = 12

    enum LedgerError: Error, Equatable {
        case exhausted
        case corruptLedger
        case unsafePath
        case invalidPurpose
        case io(Int32)
    }

    struct Reservation: Codable, Equatable, Sendable {
        let attempt: Int
        let purpose: String
    }

    struct Snapshot: Codable, Equatable, Sendable {
        let version: Int
        let maximumAttempts: Int
        let reservations: [Reservation]
        var remaining: Int { maximumAttempts - reservations.count }
    }

    private let url: URL
    private let mutex = NSLock()

    /// The parent directory must already exist. Rejects symlink parent, data and
    /// lock entries, non-regular files and hard links. No Foundation symlink-following writes.
    init(url: URL) throws {
        guard url.isFileURL, !url.lastPathComponent.isEmpty,
              ![".", ".."].contains(url.lastPathComponent) else { throw LedgerError.unsafePath }
        self.url = url
        try withFileLock { directory, createdLock in
            if try read(directory: directory) == nil {
                guard createdLock else { throw LedgerError.corruptLedger }
                try persist(Snapshot(version: 1, maximumAttempts: Self.maximumAttempts, reservations: []),
                            directory: directory)
            }
        }
    }

    func snapshot() throws -> Snapshot {
        try withFileLock { directory, _ in
            guard let state = try read(directory: directory) else { throw LedgerError.corruptLedger }
            return state
        }
    }

    /// Returns only after the reservation has been atomically replaced AND fsynced.
    /// An ambiguous disk failure consumes any written reservation; never retry it automatically.
    @discardableResult
    func reserve(purpose: String) throws -> Reservation {
        guard Self.validPurpose(purpose) else { throw LedgerError.invalidPurpose }
        return try withFileLock { directory, _ in
            guard let state = try read(directory: directory) else { throw LedgerError.corruptLedger }
            guard state.remaining > 0 else { throw LedgerError.exhausted }
            let reservation = Reservation(attempt: state.reservations.count + 1, purpose: purpose)
            try persist(Snapshot(version: 1, maximumAttempts: Self.maximumAttempts,
                                 reservations: state.reservations + [reservation]), directory: directory)
            return reservation
        }
    }

    /// Preferred network boundary: persist first, invoke exactly once, propagate failure.
    /// The lock is released before awaiting; simultaneous calls still reserve distinct attempts.
    func withReservation<T>(purpose: String, operation: () async throws -> T) async throws -> T {
        try reserve(purpose: purpose)
        return try await operation()
    }

    private static func validPurpose(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 80 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
                || [45, 46, 58, 95].contains($0)
        }
    }

    /// A separate, never-renamed lock inode is essential: flock on the data inode
    /// would cease protecting new openers after atomic rename. Each operation opens
    /// its own descriptor, so flock also serializes independent instances in a process.
    private func withFileLock<T>(_ body: (Int32, Bool) throws -> T) throws -> T {
        mutex.lock()
        defer { mutex.unlock() }
        let directory = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw Self.pathError() }
        defer { close(directory) }
        let lockName = url.lastPathComponent + ".lock"
        var createdLock = false
        var lockFD = openat(directory, lockName, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        if lockFD >= 0 {
            createdLock = true
        } else if errno == EEXIST {
            lockFD = openat(directory, lockName, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        }
        guard lockFD >= 0 else { throw Self.pathError() }
        defer { close(lockFD) }
        var info = stat()
        guard fstat(lockFD, &info) == 0 else { throw LedgerError.io(errno) }
        guard Self.isRegular(info), info.st_nlink == 1 else { throw LedgerError.unsafePath }
        while flock(lockFD, LOCK_EX) != 0 {
            guard errno == EINTR else { throw LedgerError.io(errno) }
        }
        defer { _ = flock(lockFD, LOCK_UN) }
        var namedInfo = stat()
        guard fstatat(directory, lockName, &namedInfo, AT_SYMLINK_NOFOLLOW) == 0,
              Self.isRegular(namedInfo), namedInfo.st_ino == info.st_ino,
              namedInfo.st_dev == info.st_dev, namedInfo.st_nlink == 1 else { throw LedgerError.unsafePath }
        return try body(directory, createdLock)
    }

    private func read(directory: Int32) throws -> Snapshot? {
        let descriptor = openat(directory, url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw Self.pathError()
        }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { throw LedgerError.io(errno) }
        guard Self.isRegular(info), info.st_nlink == 1 else { throw LedgerError.unsafePath }
        guard info.st_size > 0, info.st_size <= 32_768 else { throw LedgerError.corruptLedger }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 {
                if errno == EINTR { continue }
                throw LedgerError.io(errno)
            }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= 32_768 else { throw LedgerError.corruptLedger }
        }
        guard let state = try? JSONDecoder().decode(Snapshot.self, from: data),
              state.version == 1, state.maximumAttempts == Self.maximumAttempts,
              state.reservations.count <= Self.maximumAttempts,
              state.reservations.enumerated().allSatisfy({ index, reservation in
                  reservation.attempt == index + 1 && Self.validPurpose(reservation.purpose)
              }) else { throw LedgerError.corruptLedger }
        return state
    }

    private func persist(_ state: Snapshot, directory: Int32) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(state)
        let temporaryName = ".\(url.lastPathComponent).\(UUID().uuidString).tmp"
        let descriptor = openat(directory, temporaryName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw Self.pathError() }
        defer { close(descriptor); _ = unlinkat(directory, temporaryName, 0) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw LedgerError.io(errno) }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw LedgerError.io(errno) }
        guard renameat(directory, temporaryName, directory, url.lastPathComponent) == 0 else {
            throw LedgerError.io(errno)
        }
        guard fsync(directory) == 0 else { throw LedgerError.io(errno) }
    }

    private static func isRegular(_ info: stat) -> Bool { (info.st_mode & S_IFMT) == S_IFREG }
    private static func pathError() -> LedgerError {
        errno == ELOOP || errno == ENOTDIR ? .unsafePath : .io(errno)
    }
}
