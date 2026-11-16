import Darwin
import Foundation
import XCTest

final class PetAIBubbleProbeSafetyTests: XCTestCase {
    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp/pet-probe-safety-\(UUID().uuidString.prefix(10))")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testInheritedPrivateEnvironmentCannotReachProbe() throws {
        let root = try directory()
        let poisoned = ["PATH": "/usr/bin:/bin", "HOME": "/synthetic/private",
            "CODEX_HOME": "/synthetic/private/codex", "PET_TASK_LEASE": "/synthetic/private/lease",
            "BAILONG_PET_LIBRARY_DIR": "/synthetic/private/library", "BAILONG_ASSETS_DIR": "/synthetic/private/assets",
            "PYTHONPATH": "/synthetic/private/modules", "PYTHONSTARTUP": "/synthetic/private/startup.py",
            "API_KEY": "synthetic-not-a-key", "QT_DEBUG_PLUGINS": "1",
            "PET_SYNTHETIC_XCTEST_PHASE": "untrusted-inherited-phase"]
        let environment = PetBubbleProbeProcess.environment(inherited: poisoned, state: root)
        XCTAssertEqual(environment["HOME"], root.path)
        XCTAssertEqual(environment["CODEX_HOME"], root.appendingPathComponent("synthetic-codex").path)
        XCTAssertEqual(environment["BAILONG_PET_LIBRARY_DIR"], root.appendingPathComponent("empty-pet-library").path)
        for key in ["PET_TASK_LEASE", "BAILONG_ASSETS_DIR", "PYTHONPATH", "PYTHONSTARTUP", "API_KEY", "QT_DEBUG_PLUGINS", "PET_SYNTHETIC_XCTEST_PHASE"] {
            XCTAssertNil(environment[key], key)
        }
    }

    func testNoisyProbeDoesNotBlockOnUndrainedOutput() async throws {
        let root = try directory()
        let result = try await PetBubbleProbeProcess.run(executable: URL(fileURLWithPath: "/usr/bin/env"),
            arguments: ["python3", "-c", "import os; os.write(1, b'o' * 300000); os.write(2, b'e' * 300000)"],
            state: root, timeout: 3)
        XCTAssertFalse(result.timedOut)
        XCTAssertEqual(result.terminationStatus, 0)
        XCTAssertEqual(result.output, Data(repeating: 111, count: 300_000))
        XCTAssertEqual(result.diagnostics, Data(repeating: 101, count: 300_000))
    }

    func testTimedOutOwnedProbeIsReapedAndPreservesDiagnostics() async throws {
        let root = try directory()
        let result = try await PetBubbleProbeProcess.run(executable: URL(fileURLWithPath: "/usr/bin/env"),
            arguments: ["python3", "-u", "-c", "import signal,time,sys; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('synthetic probe ready', file=sys.stderr, flush=True); time.sleep(60)"],
            state: root, timeout: 1)
        XCTAssertTrue(result.timedOut)
        XCTAssertTrue(result.escalated, "仅对本测试创建且忽略SIGTERM的探针测试强制回收")
        XCTAssertNotEqual(result.terminationStatus, 0)
        XCTAssertTrue(String(decoding: result.diagnostics, as: UTF8.self).contains("synthetic probe ready"))
        XCTAssertEqual(Darwin.kill(result.processID, 0), -1, "删除临时目录前必须确认自有探针已退出")
        XCTAssertEqual(errno, ESRCH)
    }
}
