import CharacterCore
import CharacterMemory
import Darwin
import Foundation
import XCTest

/// 每个阶段运行在全新XCTest进程，不复用store或进程内授权注册表。
/// 不启动产品、不触碰真实资料、不使用模型/Keychain/声音。
final class CharacterAdaptationProcessTests: XCTestCase {
    private static let marker = "synthetic-adaptation-restart-v1"
    private static let petID = "synthetic-restart"
    private static let corruptRecord = Data("{\"schemaVersion\":1,\"revision\":\"synthetic-corrupt\"}".utf8)
    private static let feedback = CharacterChatTurn(role: .user, text: "以后请回答简短一点。",
        createdAt: Date(timeIntervalSince1970: 1_700_000_000),
        id: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!)

    private struct Receipt: Codable {
        let phase: String
        let pid: Int32
        let state: CharacterAdaptationState
    }

    private func root() throws -> URL {
        let url = URL(fileURLWithPath: "/tmp/pet-adaptation-restart-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try Data(Self.marker.utf8).write(to: url.appendingPathComponent("fixture-marker"))
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func adaptationFile(_ root: URL) -> URL {
        root.appendingPathComponent("pets/\(Self.petID)/character/adaptation.json")
    }

    private func childRoot() throws -> URL {
        let home = try XCTUnwrap(ProcessInfo.processInfo.environment["HOME"])
        let root = URL(fileURLWithPath: home)
        guard home.hasPrefix("/tmp/pet-adaptation-restart-"),
              try Data(contentsOf: root.appendingPathComponent("fixture-marker")) == Data(Self.marker.utf8),
              ProcessInfo.processInfo.environment["CODEX_HOME"] == root.appendingPathComponent("synthetic-codex").path,
              ProcessInfo.processInfo.environment["PET_TASK_LEASE"] == nil else {
            throw CocoaError(.fileReadNoPermission)
        }
        return root
    }

    private func runPhases(_ phases: [String], selector: String, root: URL) async throws -> [Receipt] {
        var receipts: [Receipt] = []
        for phase in phases {
            let result = try await PetBubbleProbeProcess.run(
                executable: URL(fileURLWithPath: CommandLine.arguments[0]),
                arguments: ["-XCTest", "PetCompanionTests.CharacterAdaptationProcessTests/\(selector)",
                            Bundle(for: Self.self).bundleURL.path],
                state: root, timeout: 15, fixturePhase: phase)
            let diagnostic = String(decoding: result.output + result.diagnostics, as: UTF8.self)
            XCTAssertFalse(result.timedOut, "\(phase): \(diagnostic)")
            XCTAssertEqual(result.terminationStatus, 0, "\(phase): \(diagnostic)")
            // 即使进程成功退出，也必须证明指定阶段确实执行，不能让错误的selector空跑。
            let receipt = try JSONDecoder().decode(Receipt.self,
                from: Data(contentsOf: root.appendingPathComponent("\(phase).receipt.json")))
            XCTAssertEqual(receipt.phase, phase)
            XCTAssertEqual(receipt.pid, result.processID)
            XCTAssertNotEqual(receipt.pid, getpid())
            receipts.append(receipt)
        }
        return receipts
    }

    private func finish(_ phase: String, state: CharacterAdaptationState, root: URL) throws {
        try JSONEncoder().encode(Receipt(phase: phase, pid: getpid(), state: state))
            .write(to: root.appendingPathComponent("\(phase).receipt.json"), options: .atomic)
    }

    func testSeparateProcessesRestoreSharingRevocationRollbackAndReset() async throws {
        if let phase = ProcessInfo.processInfo.environment["PET_SYNTHETIC_XCTEST_PHASE"] {
            let root = try childRoot()
            let store = try CharacterMemoryStore(stateDirectory: root, petID: Self.petID)
            try await lifecyclePhase(phase, store: store, root: root)
            return
        }
        let root = try root()
        let phases = ["learn", "share", "revoke", "resume-local", "rollback", "reset", "verify-reset"]
        let receipts = try await runPhases(phases,
            selector: "testSeparateProcessesRestoreSharingRevocationRollbackAndReset", root: root)
        XCTAssertEqual(receipts.map { $0.state.revision }, [1, 1, 1, 2, 3, 4, 4])
        let identity = root.appendingPathComponent("pets/\(Self.petID)/character/identity.md")
        XCTAssertEqual(try Data(contentsOf: identity), try Data(contentsOf: root.appendingPathComponent("identity-baseline")))
        let other = root.appendingPathComponent("pets/another-synthetic/character/adaptation.json")
        XCTAssertEqual(try Data(contentsOf: other), try Data(contentsOf: root.appendingPathComponent("other-baseline")))
        let permissions = try FileManager.default.attributesOfItem(atPath: adaptationFile(root).path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    private func lifecyclePhase(_ phase: String, store: CharacterMemoryStore, root: URL) async throws {
        switch phase {
        case "learn":
            let initial = try await store.loadAdaptation()
            XCTAssertEqual(initial, CharacterAdaptationState())
            try await store.saveIdentity(CharacterIdentity(name: "合成陪伴者", background: "固定身份，不允许自动改写。"))
            let identity = root.appendingPathComponent("pets/\(Self.petID)/character/identity.md")
            try Data(contentsOf: identity).write(to: root.appendingPathComponent("identity-baseline"))
            let other = try CharacterMemoryStore(stateDirectory: root, petID: "another-synthetic")
            _ = try await other.observeAdaptation(.init(role: .user, text: "请稳重一点。"))
            let otherFile = root.appendingPathComponent("pets/another-synthetic/character/adaptation.json")
            try Data(contentsOf: otherFile).write(to: root.appendingPathComponent("other-baseline"))
            let learned = try await store.observeAdaptation(Self.feedback)
            XCTAssertEqual(learned.verbosity, -1)
            XCTAssertFalse(learned.shareWithOnlineModel)
            XCTAssertTrue(learned.promptText.isEmpty)
        case "share":
            let restored = try await store.loadAdaptation()
            XCTAssertEqual(restored.revision, 1)
            XCTAssertEqual(restored.verbosity, -1)
            XCTAssertEqual(restored.history.last?.evidence?.turnID, Self.feedback.id)
            XCTAssertEqual(restored.history.last?.evidence?.text, Self.feedback.text)
            XCTAssertFalse(restored.shareWithOnlineModel)
            let before = try Data(contentsOf: adaptationFile(root))
            let duplicate = try await store.observeAdaptation(Self.feedback)
            XCTAssertEqual(duplicate.revision, 1)
            XCTAssertEqual(try Data(contentsOf: adaptationFile(root)), before, "重启后重复轮次不能再次学习/写盘")
            let shared = try await store.applyAdaptationOperation(.sharing(true))
            let context = CharacterContextBuilder.make(identity: nil, memories: [], adaptation: shared, query: "解释缓存")
            XCTAssertTrue(context?.contains("120字") == true)
            XCTAssertFalse(context?.contains(Self.feedback.text) == true)
        case "revoke":
            let restored = try await store.loadAdaptation()
            XCTAssertTrue(restored.shareWithOnlineModel)
            XCTAssertFalse(restored.promptText.isEmpty)
            let unshared = try await store.applyAdaptationOperation(.sharing(false))
            XCTAssertTrue(unshared.enabled, "单独撤销分享时本地学习仍开启")
            XCTAssertTrue(restored.promptText.isEmpty, "分享撤权本身必须立即使旧快照失效")
            XCTAssertNil(CharacterContextBuilder.make(identity: nil, memories: [], adaptation: restored, query: "解释缓存"))
            _ = try await store.applyAdaptationOperation(.enabled(false))
            let ignored = try await store.observeAdaptation(.init(role: .user, text: "请活泼一点。"))
            XCTAssertEqual(ignored.revision, 1)
            XCTAssertTrue(restored.promptText.isEmpty, "当前进程旧快照必须立即失效")
        case "resume-local":
            let restored = try await store.loadAdaptation()
            XCTAssertFalse(restored.enabled)
            XCTAssertFalse(restored.shareWithOnlineModel)
            XCTAssertTrue(restored.promptText.isEmpty)
            let ignored = try await store.observeAdaptation(.init(role: .user, text: "请详细一点。"))
            XCTAssertEqual(ignored.revision, 1)
            _ = try await store.applyAdaptationOperation(.enabled(true))
            let learned = try await store.observeAdaptation(.init(role: .user, text: "请活泼一点。"))
            XCTAssertEqual(learned.revision, 2)
            XCTAssertEqual(learned.verbosity, -1)
            XCTAssertEqual(learned.playfulness, 1)
            XCTAssertFalse(learned.shareWithOnlineModel, "重开本地学习不得顺带开启在线分享")
        case "rollback":
            let restored = try await store.loadAdaptation()
            XCTAssertEqual(restored.revision, 2)
            XCTAssertEqual(restored.playfulness, 1)
            let rolledBack = try await store.applyAdaptationOperation(.rollback)
            XCTAssertEqual(rolledBack.revision, 3)
            XCTAssertEqual(rolledBack.verbosity, -1)
            XCTAssertEqual(rolledBack.playfulness, 0)
            XCTAssertEqual(rolledBack.history.last?.revertedRevision, 2)
            _ = try await store.applyAdaptationOperation(.sharing(true))
        case "reset":
            let restored = try await store.loadAdaptation()
            XCTAssertEqual(restored.revision, 3)
            XCTAssertEqual(restored.playfulness, 0)
            XCTAssertTrue(restored.shareWithOnlineModel)
            let reset = try await store.applyAdaptationOperation(.reset)
            XCTAssertEqual(reset.revision, 4)
            XCTAssertEqual(reset.verbosity, 0)
            XCTAssertEqual(reset.playfulness, 0)
            XCTAssertTrue(reset.enabled)
            XCTAssertTrue(reset.shareWithOnlineModel)
        case "verify-reset":
            let restored = try await store.loadAdaptation()
            XCTAssertEqual(restored.revision, 4)
            XCTAssertEqual(restored.history.last?.kind, .reset)
            XCTAssertEqual(restored.verbosity, 0)
            XCTAssertEqual(restored.playfulness, 0)
            XCTAssertEqual(restored.initiative, 0)
            XCTAssertTrue(restored.enabled)
            XCTAssertTrue(restored.shareWithOnlineModel)
            XCTAssertTrue(restored.promptText.isEmpty)
            let noUndo = try await store.applyAdaptationOperation(.rollback)
            XCTAssertEqual(noUndo.revision, 4, "重启后仍不能撤销到重置之前")
        default: XCTFail("未知合成阶段：\(phase)"); return
        }
        let state = try await store.loadAdaptation()
        let records = try await store.listMemories()
        XCTAssertTrue(records.isEmpty, "表达适应不得顺带生成长期记忆")
        try finish(phase, state: state, root: root)
    }

    func testSeparateProcessesRetainBoundedHistoryAndResetBarrier() async throws {
        if let phase = ProcessInfo.processInfo.environment["PET_SYNTHETIC_XCTEST_PHASE"] {
            let root = try childRoot()
            let store = try CharacterMemoryStore(stateDirectory: root, petID: Self.petID)
            switch phase {
            case "history-fill":
                for index in 0..<48 {
                    _ = try await store.observeAdaptation(.init(role: .user,
                        text: index.isMultiple(of: 2) ? "请简短一点。" : "请详细一点。"))
                }
            case "history-undo":
                let restored = try await store.loadAdaptation()
                XCTAssertEqual(restored.revision, 48)
                XCTAssertEqual(restored.history.count, 30)
                XCTAssertEqual(restored.history.first?.revision, 19)
                XCTAssertEqual(restored.verbosity, 1)
                let rolledBack = try await store.applyAdaptationOperation(.rollback)
                XCTAssertEqual(rolledBack.revision, 49)
                XCTAssertEqual(rolledBack.history.count, 30)
                XCTAssertEqual(rolledBack.history.last?.revertedRevision, 48)
                XCTAssertEqual(rolledBack.verbosity, -1)
                let evidence = try XCTUnwrap(restored.history.last?.evidence)
                let beforeReplay = try Data(contentsOf: adaptationFile(root))
                let replay = try await store.observeAdaptation(.init(role: .user, text: evidence.text,
                    createdAt: evidence.createdAt, id: evidence.turnID))
                XCTAssertEqual(replay.revision, 49)
                XCTAssertEqual(replay.verbosity, -1, "已撤销的旧轮次重放不能重新学回详细表达")
                XCTAssertEqual(try Data(contentsOf: adaptationFile(root)), beforeReplay)
                _ = try await store.applyAdaptationOperation(.reset)
            case "history-verify":
                let restored = try await store.loadAdaptation()
                XCTAssertEqual(restored.revision, 50)
                XCTAssertEqual(restored.history.count, 30)
                XCTAssertEqual(restored.history.first?.revision, 21)
                XCTAssertEqual(restored.history.last?.kind, .reset)
                XCTAssertEqual(restored.verbosity, 0)
                let noUndo = try await store.applyAdaptationOperation(.rollback)
                XCTAssertEqual(noUndo.revision, 50)
            default: XCTFail("未知合成阶段：\(phase)"); return
            }
            let state = try await store.loadAdaptation()
            XCTAssertTrue(state.enabled)
            XCTAssertFalse(state.shareWithOnlineModel)
            XCTAssertTrue(state.promptText.isEmpty)
            XCTAssertEqual(state.history.count, 30)
            XCTAssertLessThanOrEqual(try Data(contentsOf: adaptationFile(root)).count, 64 * 1024)
            try finish(phase, state: state, root: root)
            return
        }
        let root = try root()
        let receipts = try await runPhases(["history-fill", "history-undo", "history-verify"],
            selector: "testSeparateProcessesRetainBoundedHistoryAndResetBarrier", root: root)
        XCTAssertEqual(receipts.map { $0.state.revision }, [48, 50, 50])
    }

    func testSeparateProcessRejectsCorruptionWithoutOverwritingEvidence() async throws {
        if let phase = ProcessInfo.processInfo.environment["PET_SYNTHETIC_XCTEST_PHASE"] {
            let root = try childRoot()
            let store = try CharacterMemoryStore(stateDirectory: root, petID: Self.petID)
            if phase == "prepare-corruption" {
                let state = try await store.observeAdaptation(Self.feedback)
                XCTAssertEqual(state.revision, 1)
                // 损坏注入也只由自有子阶段执行，父进程不写角色文件。
                try Self.corruptRecord.write(to: adaptationFile(root), options: .atomic)
                try finish(phase, state: state, root: root)
            } else if phase == "reject-corruption" {
                let bytes = try Data(contentsOf: adaptationFile(root))
                do { _ = try await store.loadAdaptation(); XCTFail("损坏资料不能静默当作默认人格") }
                catch CharacterMemoryStoreError.invalidRecord { }
                do { _ = try await store.observeAdaptation(Self.feedback); XCTFail("损坏资料不能被反馈覆盖") }
                catch CharacterMemoryStoreError.invalidRecord { }
                do { _ = try await store.applyAdaptationOperation(.sharing(true)); XCTFail("损坏资料不能被授权操作覆盖") }
                catch CharacterMemoryStoreError.invalidRecord { }
                XCTAssertEqual(try Data(contentsOf: adaptationFile(root)), bytes)
                try finish(phase, state: CharacterAdaptationState(), root: root)
            } else { XCTFail("未知合成阶段：\(phase)") }
            return
        }
        let root = try root()
        _ = try await runPhases(["prepare-corruption"],
            selector: "testSeparateProcessRejectsCorruptionWithoutOverwritingEvidence", root: root)
        XCTAssertEqual(try Data(contentsOf: adaptationFile(root)), Self.corruptRecord)
        _ = try await runPhases(["reject-corruption"],
            selector: "testSeparateProcessRejectsCorruptionWithoutOverwritingEvidence", root: root)
        XCTAssertEqual(try Data(contentsOf: adaptationFile(root)), Self.corruptRecord)
    }
}
