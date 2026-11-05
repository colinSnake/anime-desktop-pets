import Darwin
import Foundation
import XCTest
@testable import DragonCore

final class PetInstanceControlTests: XCTestCase {
    private var root: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }
    func testEveryWhitelistedCommandEncodesCorrectly() throws {
        let requests: [PetInstanceControlRequest] = [.init(.status), .init(.startPet, instanceID: "first"),
            .init(.stopPet, instanceID: "first"), .init(.startSelected, instanceIDs: ["first", "second"]),
            .init(.stopAll), .init(.shutdown), .init(.setPreferences, instanceID: "first", preferences: .init(size: 128))]
            + [.init(.clonePet, instanceID: "first", cloneID: "first-copy"), .init(.deletePet, instanceID: "first-copy")]
        for request in requests {
            let bytes = try request.encoded()
            XCTAssertEqual(bytes.last, 10)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            XCTAssertEqual(object["protocolVersion"] as? Int, 1)
            XCTAssertEqual(object["command"] as? String, request.command.rawValue)
            XCTAssertNil(object["script"])
        }
    }
    func testInvalidFieldsAndPreferencesRejectedBeforeConnecting() {
        let requests: [PetInstanceControlRequest] = [.init(.status, instanceID: "first"), .init(.startPet),
            .init(.startPet, instanceID: "../escape"), .init(.status, requestId: "bad\n"),
            .init(.startSelected, instanceIDs: []), .init(.startSelected, instanceIDs: ["first", "first"]),
            .init(.startSelected, instanceIDs: (1...33).map { "p\($0)" }),
            .init(.setPreferences, instanceID: "first", preferences: .init(size: 385)),
            .init(.setPreferences, instanceID: "first", preferences: .init(size: 127)),
            .init(.setPreferences, instanceID: "first", preferences: .init(x: .nan)),
            .init(.clonePet), .init(.clonePet, instanceID: "first"),
            .init(.clonePet, instanceID: "first", cloneID: "first"),
            .init(.clonePet, instanceID: "../bad", cloneID: "copy")]
        for request in requests { XCTAssertThrowsError(try request.encoded()) }
    }
    func testUnknownCommandFailsDecode() {
        XCTAssertThrowsError(try JSONDecoder().decode(PetInstanceControlRequest.self,
            from: Data(#"{"protocolVersion":1,"requestId":"test","command":"run_shell"}"#.utf8)))
    }
    func testLegacyStatusCloneDefaultsToNotAutoRestored() throws {
        let json = #"{"id":"white-dragon-copy-2","package":{"id":"local.dragon","version":"1.0.0"},"enabled":true,"preferences":{"size":256,"scheduledActivity":true,"movement":true,"hideInFullscreen":true},"phase":"stopped"}"#
        let row = try JSONDecoder().decode(PetInstanceControlRow.self, from: Data(json.utf8))
        XCTAssertFalse(row.autoStartOnLaunch)
        let regular = json.replacingOccurrences(of: "white-dragon-copy-2", with: "copy-pet")
        XCTAssertTrue(try JSONDecoder().decode(PetInstanceControlRow.self, from: Data(regular.utf8)).autoStartOnLaunch)
    }
    func testReplyCorrelationAndErrorEnvelope() throws {
        let request = PetInstanceControlRequest(.status, requestId: "match")
        let error = Data(#"{"protocolVersion":1,"requestId":"match","ok":false,"error":{"code":"test","message":"fixture"}}"#.utf8)
        XCTAssertFalse(try PetInstanceControlReply.decode(error, for: request).ok)
        for text in [#"{"protocolVersion":2,"requestId":"match","ok":false,"error":{"code":"a","message":"b"}}"#,
                     #"{"protocolVersion":1,"requestId":"other","ok":false,"error":{"code":"a","message":"b"}}"#,
                     #"{"protocolVersion":1,"requestId":"match","ok":true}"#] {
            XCTAssertThrowsError(try PetInstanceControlReply.decode(Data(text.utf8), for: request))
        }
    }
    func testUnavailableControllerIsNotStarted() throws {
        let profile = URL(fileURLWithPath: "/tmp/dps-" + UUID().uuidString.prefix(8))
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: profile) }
        XCTAssertThrowsError(try PetInstanceControlClient.send(.init(.status), directory: profile)) { error in
            guard case PetInstanceTransportError.unavailable = error else { return XCTFail("\(error)") }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: profile.appendingPathComponent("pet-control.sock").path))
    }
    func testInsecureDirectoryRefused() throws {
        let profile = URL(fileURLWithPath: "/tmp/dps-" + UUID().uuidString.prefix(8))
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        defer { try? FileManager.default.removeItem(at: profile) }
        XCTAssertThrowsError(try PetInstanceControlClient.send(.init(.status), directory: profile))
    }
    func testLostOrInvalidConfirmationIsUncertainAndNeverReplayed() throws {
        let python = root.appendingPathComponent(".local/pet-build/venv/bin/python")
        guard FileManager.default.isExecutableFile(atPath: python.path) else { throw XCTSkip("专用Qt环境不存在") }
        for mode in ["disconnect", "wrong-id", "oversized", "slow"] {
            let profile = URL(fileURLWithPath: "/tmp/dps-" + UUID().uuidString.prefix(8))
            try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: profile) }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            process.arguments = ["-p", #"(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (deny network-inbound (local ip "*:*"))"#,
                                 python.path, root.appendingPathComponent("scripts/test-instance-ipc.py").path, "--transport-fixture", profile.path, mode]
            var environment = ProcessInfo.processInfo.environment
            environment["HOME"] = profile.path; environment["DRAGON_INSTANCE_IPC_FIXTURE"] = "1"
            environment["QT_QPA_PLATFORM"] = "offscreen"
            process.environment = environment; process.standardOutput = Pipe(); process.standardError = Pipe()
            try process.run()
            defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
            let path = profile.appendingPathComponent("pet-control.sock").path
            let readyDeadline = ProcessInfo.processInfo.systemUptime + 5
            while !FileManager.default.fileExists(atPath: path), process.isRunning,
                  ProcessInfo.processInfo.systemUptime < readyDeadline { Thread.sleep(forTimeInterval: 0.01) }
            XCTAssertThrowsError(try PetInstanceControlClient.send(.init(.stopAll), directory: profile, timeout: mode == "slow" ? 0.05 : 2)) { error in
                guard case PetInstanceTransportError.uncertain = error else { return XCTFail("\(mode): \(error)") }
            }
            XCTAssertEqual(try String(contentsOf: profile.appendingPathComponent("delivery-count")), "1")
        }
    }
    func testSwiftClientToRealQtController() throws {
        let python = root.appendingPathComponent(".local/pet-build/venv/bin/python")
        guard FileManager.default.isExecutableFile(atPath: python.path) else { throw XCTSkip("专用Qt环境不存在") }
        let profile = URL(fileURLWithPath: "/tmp/dps-" + UUID().uuidString.prefix(8))
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: profile) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        process.arguments = ["-p", #"(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (deny network-inbound (local ip "*:*"))"#,
                             python.path, root.appendingPathComponent("scripts/test-instance-ipc.py").path, "--fixture-server", profile.path]
        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = profile.path; environment["BAILONG_DATA_DIR"] = profile.path
        environment["QT_QPA_PLATFORM"] = "offscreen"; environment["DRAGON_INSTANCE_IPC_FIXTURE"] = "1"
        process.environment = environment
        process.standardOutput = Pipe(); process.standardError = Pipe()
        try process.run()
        defer {
            if process.isRunning { process.terminate(); process.waitUntilExit() }
        }
        let socketPath = profile.appendingPathComponent("pet-control.sock").path
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while !FileManager.default.fileExists(atPath: socketPath), process.isRunning,
              ProcessInfo.processInfo.systemUptime < deadline { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertTrue(process.isRunning)
        func send(_ request: PetInstanceControlRequest) throws -> PetInstanceControlReply {
            try PetInstanceControlClient.send(request, directory: profile)
        }
        let status = try XCTUnwrap(send(.init(.status)).result)
        XCTAssertEqual(status.controllerPID, process.processIdentifier)
        XCTAssertTrue(status.status.instances.allSatisfy { $0.phase == .stopped })
        XCTAssertTrue(try send(.init(.startSelected, instanceIDs: ["first", "second"])).ok)
        let readyDeadline = ProcessInfo.processInfo.systemUptime + 2
        while ProcessInfo.processInfo.systemUptime < readyDeadline {
            if try send(.init(.status)).result?.status.instances.filter({ $0.phase == .running }).count == 2 { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        XCTAssertEqual(try send(.init(.status)).result?.status.instances.filter({ $0.phase == .running }).count, 2)
        XCTAssertTrue(try send(.init(.setPreferences, instanceID: "first", preferences: .init(size: 128))).ok)
        let rows = try XCTUnwrap(send(.init(.status)).result?.status.instances)
        XCTAssertEqual(rows.first(where: { $0.id == "first" })?.preferences.size, 128)
        XCTAssertEqual(rows.first(where: { $0.id == "second" })?.preferences.size, 256)
        XCTAssertTrue(try send(.init(.stopPet, instanceID: "first")).ok)
        XCTAssertEqual(try send(.init(.status)).result?.status.instances.first(where: { $0.id == "second" })?.phase, .running)
        XCTAssertTrue(try send(.init(.shutdown)).ok)
        let exitDeadline = ProcessInfo.processInfo.systemUptime + 3
        while process.isRunning, ProcessInfo.processInfo.systemUptime < exitDeadline { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertFalse(process.isRunning)
        XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath))
    }
}
