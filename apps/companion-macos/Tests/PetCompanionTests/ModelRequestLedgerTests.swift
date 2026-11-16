import Foundation
import XCTest
@testable import PetCompanion

final class ModelRequestLedgerTests: XCTestCase {
    private func ledgerURL() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pet-ledger-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("requests.json")
    }

    func testThirteenthReservationIsRejectedAndReopeningPreservesCount() throws {
        let url = try ledgerURL()
        let ledger = try ModelRequestLedger(url: url)
        for attempt in 1...12 {
            XCTAssertEqual(try ledger.reserve(purpose: "memory").attempt, attempt)
        }
        XCTAssertThrowsError(try ModelRequestLedger(url: url).reserve(purpose: "reply")) {
            XCTAssertEqual($0 as? ModelRequestLedger.LedgerError, .exhausted)
        }
        XCTAssertEqual(try ledger.snapshot().reservations.count, 12)
        XCTAssertEqual(try ledger.snapshot().remaining, 0)
    }

    func testFailedOperationIsAlreadyPersistedAndNeverRetriedOrRefunded() async throws {
        enum SyntheticFailure: Error { case offline }
        let url = try ledgerURL()
        let ledger = try ModelRequestLedger(url: url)
        var calls = 0
        do {
            let _: String = try await ledger.withReservation(purpose: "speech") {
                calls += 1
                XCTAssertEqual(try ModelRequestLedger(url: url).snapshot().reservations.count, 1)
                throw SyntheticFailure.offline
            }
            XCTFail("Expected synthetic failure")
        } catch SyntheticFailure.offline { }
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(try ModelRequestLedger(url: url).snapshot().remaining, 11)
        for _ in 0..<11 { _ = try ledger.reserve(purpose: "reply") }
        do {
            let _: String = try await ledger.withReservation(purpose: "bubble") {
                calls += 1
                return "Must not execute"
            }
            XCTFail("Budget must be enforced before calling the operation")
        } catch ModelRequestLedger.LedgerError.exhausted { }
        XCTAssertEqual(calls, 1)
    }

    func testCorruptTruncatedOrTamperedLedgerFailsClosed() throws {
        let url = try ledgerURL()
        let ledger = try ModelRequestLedger(url: url)
        for bytes in [Data(), Data("{".utf8), Data("{\"version\":1,\"reservations\":[]}".utf8),
                      Data("{\"version\":1,\"maximumAttempts\":13,\"reservations\":[]}".utf8)] {
            try bytes.write(to: url)
            XCTAssertThrowsError(try ModelRequestLedger(url: url))
            XCTAssertThrowsError(try ledger.reserve(purpose: "memory"))
            XCTAssertEqual(try Data(contentsOf: url), bytes)
        }
    }

    func testInvalidPurposeDoesNotConsumeBudget() throws {
        let ledger = try ModelRequestLedger(url: ledgerURL())
        for purpose in ["", "memory\nreply", String(repeating: "a", count: 81), "user private text"] {
            XCTAssertThrowsError(try ledger.reserve(purpose: purpose)) {
                XCTAssertEqual($0 as? ModelRequestLedger.LedgerError, .invalidPurpose)
            }
        }
        XCTAssertEqual(try ledger.snapshot().remaining, 12)
    }

    func testInvalidVersionNoncontiguousAttemptsAndOversizedLedgerAreRejected() throws {
        let url = try ledgerURL()
        _ = try ModelRequestLedger(url: url)
        let states = [
            ModelRequestLedger.Snapshot(version: 2, maximumAttempts: 12, reservations: []),
            ModelRequestLedger.Snapshot(version: 1, maximumAttempts: 12,
                reservations: [.init(attempt: 0, purpose: "memory")]),
            ModelRequestLedger.Snapshot(version: 1, maximumAttempts: 12,
                reservations: [.init(attempt: 1, purpose: "memory"), .init(attempt: 1, purpose: "reply")]),
            ModelRequestLedger.Snapshot(version: 1, maximumAttempts: 12,
                reservations: (1...13).map { .init(attempt: $0, purpose: "memory") })
        ]
        for state in states {
            let bytes = try JSONEncoder().encode(state)
            try bytes.write(to: url)
            XCTAssertThrowsError(try ModelRequestLedger(url: url))
            XCTAssertEqual(try Data(contentsOf: url), bytes)
        }
        try Data(repeating: 32, count: 32_769).write(to: url)
        XCTAssertThrowsError(try ModelRequestLedger(url: url))
    }

    func testSymlinkSwapAfterInitializationAndHardLinkedDataAreRejected() throws {
        let url = try ledgerURL()
        let ledger = try ModelRequestLedger(url: url)
        _ = try ledger.reserve(purpose: "memory")
        let target = url.deletingLastPathComponent().appendingPathComponent("unchanged.json")
        let original = try Data(contentsOf: url)
        try original.write(to: target)
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
        XCTAssertThrowsError(try ledger.reserve(purpose: "reply"))
        XCTAssertEqual(try Data(contentsOf: target), original)
        try FileManager.default.removeItem(at: url)
        try FileManager.default.linkItem(at: target, to: url)
        XCTAssertThrowsError(try ledger.reserve(purpose: "reply"))
        XCTAssertEqual(try Data(contentsOf: target), original)
    }

    func testSymlinkLedgerLockAndParentAreRejectedWithoutTouchingTarget() throws {
        let url = try ledgerURL()
        let target = url.deletingLastPathComponent().appendingPathComponent("untouched")
        let bytes = Data("do not touch".utf8)
        try bytes.write(to: target)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
        XCTAssertThrowsError(try ModelRequestLedger(url: url))
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        try FileManager.default.removeItem(at: url)
        let lock = url.appendingPathExtension("lock")
        if FileManager.default.fileExists(atPath: lock.path) { try FileManager.default.removeItem(at: lock) }
        try FileManager.default.createSymbolicLink(at: lock, withDestinationURL: target)
        XCTAssertThrowsError(try ModelRequestLedger(url: url))
        let link = url.deletingLastPathComponent().appendingPathComponent("parent-link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url.deletingLastPathComponent())
        XCTAssertThrowsError(try ModelRequestLedger(url: link.appendingPathComponent("other.json")))
        XCTAssertEqual(try Data(contentsOf: target), bytes)
    }

    func testDeletedLedgerDoesNotResetExistingBudget() throws {
        let url = try ledgerURL()
        let ledger = try ModelRequestLedger(url: url)
        _ = try ledger.reserve(purpose: "memory")
        try FileManager.default.removeItem(at: url)
        XCTAssertThrowsError(try ledger.reserve(purpose: "memory"))
        XCTAssertThrowsError(try ModelRequestLedger(url: url))
    }

    func testConcurrentIndependentInstancesCannotExceedHardCap() throws {
        let url = try ledgerURL()
        _ = try ModelRequestLedger(url: url)
        let lock = NSLock()
        var attempts: [Int] = []
        var unexpectedErrors: [String] = []
        DispatchQueue.concurrentPerform(iterations: 48) { _ in
            do {
                let reservation = try ModelRequestLedger(url: url).reserve(purpose: "parallel")
                lock.lock(); attempts.append(reservation.attempt); lock.unlock()
            } catch ModelRequestLedger.LedgerError.exhausted { }
            catch { lock.lock(); unexpectedErrors.append(String(describing: error)); lock.unlock() }
        }
        XCTAssertEqual(unexpectedErrors, [])
        XCTAssertEqual(attempts.sorted(), Array(1...12))
        XCTAssertEqual(try ModelRequestLedger(url: url).snapshot().remaining, 0)
    }

    func testCrossProcessHardCap() throws {
        let key = "PET_SYNTHETIC_LEDGER_TEST_URL"
        if let path = ProcessInfo.processInfo.environment[key] {
            let ledger = try ModelRequestLedger(url: URL(fileURLWithPath: path))
            for _ in 0..<24 {
                do { _ = try ledger.reserve(purpose: "process") }
                catch ModelRequestLedger.LedgerError.exhausted { return }
            }
            XCTFail("Child must reach the hard cap")
            return
        }
        let url = try ledgerURL()
        _ = try ModelRequestLedger(url: url)
        var children: [Process] = []
        for _ in 0..<3 {
            let child = Process()
            child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            child.arguments = ["-XCTest", "PetCompanionTests.ModelRequestLedgerTests/testCrossProcessHardCap",
                               Bundle(for: ModelRequestLedgerTests.self).bundleURL.path]
            var environment = ProcessInfo.processInfo.environment
            environment[key] = url.path
            child.environment = environment
            child.standardOutput = FileHandle.nullDevice
            child.standardError = FileHandle.nullDevice
            try child.run()
            children.append(child)
        }
        for child in children { child.waitUntilExit(); XCTAssertEqual(child.terminationStatus, 0) }
        XCTAssertEqual(try ModelRequestLedger(url: url).snapshot().reservations.map(\.attempt), Array(1...12))
    }
}
