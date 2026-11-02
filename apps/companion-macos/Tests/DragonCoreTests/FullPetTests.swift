import Darwin
import Foundation
import XCTest
@testable import DragonCore

final class PetAnimationCatalogTests: XCTestCase {
    private func fixture(_ body: (URL, inout [String: Any]) throws -> Void) throws {
        let root = URL(fileURLWithPath: "/tmp/dragon-catalog-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data([1, 2, 3]).write(to: root.appendingPathComponent("action.webp"))
        let item: [String: Any] = ["file": "action.webm", "durationMs": 1000]
        var manifest: [String: Any] = ["idle": item, "additionalIdleAnimations": [item],
            "variants": Array(repeating: item, count: 15), "workAnimations": Array(repeating: item, count: 5),
            "dragAnimation": item, "landingAnimation": item, "quotaAnimation": item]
        for key in ["idle", "dragAnimation", "landingAnimation", "quotaAnimation"] {
            manifest[key] = ["id": key, "file": "action.webm", "durationMs": 1000] as [String: Any]
        }
        for key in ["additionalIdleAnimations", "variants", "workAnimations"] {
            let items = manifest[key] as! [[String: Any]]
            manifest[key] = items.enumerated().map { index, value in
                var value = value; value["id"] = "\(key)-\(index)"; return value
            }
        }
        try body(root, &manifest)
    }
    private func store(_ manifest: [String: Any], at root: URL) throws {
        try JSONSerialization.data(withJSONObject: manifest).write(to: root.appendingPathComponent("素材清单.json"))
    }
    func testCompleteManifestCountsAndResourceMapping() throws {
        try fixture { root, manifest in
            try store(manifest, at: root)
            let result = try PetAnimationCatalog.inspect(root: root)
            XCTAssertEqual(result.actionCount, 25)
            XCTAssertEqual(result.idleCount, 2); XCTAssertEqual(result.interactionCount, 15)
            XCTAssertEqual(result.workCount, 5); XCTAssertEqual(result.specialCount, 3)
        }
    }
    func testEnhancedManifestAndMovementMetadata() throws {
        try fixture { root, manifest in
            manifest["additionalIdleAnimations"] = (0..<5).map { ["id": "extra-\($0)", "file": "action.webm", "durationMs": 1000] as [String: Any] }
            let moves = (0..<6).map { ["id": "move-\($0)", "file": "action.webm", "durationMs": 1000,
                                       "moveStartMs": 100, "moveStopMs": 800, "sourceFacing": "right"] as [String: Any] }
            manifest["movementAnimations"] = moves
            try store(manifest, at: root)
            let result = try PetAnimationCatalog.inspect(root: root)
            XCTAssertEqual(result.actionCount, 35); XCTAssertEqual(result.movementCount, 6)
            XCTAssertEqual(result.idleCount, 6)
            for wrong in [-100, 1200] {
                var invalid = moves; invalid[0]["moveStopMs"] = wrong
                manifest["movementAnimations"] = invalid
                try store(manifest, at: root)
                XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
            }
        }
    }
    func testPartialExtensionRejected() throws {
        try fixture { root, manifest in
            manifest["movementAnimations"] = [["id": "move", "file": "action.webm", "durationMs": 1000]]
            try store(manifest, at: root)
            XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
        }
    }
    func testMissingAnimationFailsInsteadOfStaticFallback() throws {
        try fixture { root, manifest in
            try store(manifest, at: root)
            try FileManager.default.removeItem(at: root.appendingPathComponent("action.webp"))
            XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
        }
    }
    func testIncompleteManifestRejected() throws {
        try fixture { root, manifest in
            manifest["variants"] = [] as [[String: Any]]
            try store(manifest, at: root)
            XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
        }
    }
    func testTraversalAndAbsolutePlaybackRejected() throws {
        for path in ["../escape.webp", "/tmp/escape.webp"] {
            try fixture { root, manifest in
                manifest["idle"] = ["playbackFile": path, "durationMs": 1000]
                try store(manifest, at: root)
                XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
            }
        }
    }
    func testSymlinkEscapeRejected() throws {
        try fixture { root, manifest in
            try FileManager.default.removeItem(at: root.appendingPathComponent("action.webp"))
            try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("action.webp").path, withDestinationPath: "/etc/hosts")
            try store(manifest, at: root)
            XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
        }
    }
    func testInvalidDurationRejected() throws {
        try fixture { root, manifest in
            manifest["idle"] = ["file": "action.webm", "durationMs": -1]
            try store(manifest, at: root)
            XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
        }
    }
    func testMissingTransitionRejected() throws {
        try fixture { root, manifest in
            manifest["idle"] = ["file": "action.webm", "durationMs": 1000,
                                "returnTransition": ["file": "missing.webm", "durationMs": 1000]]
            try store(manifest, at: root)
            XCTAssertThrowsError(try PetAnimationCatalog.inspect(root: root))
        }
    }
    func testRelativeNestedAppPath() {
        let c = CompanionConfiguration()
        let root = URL(fileURLWithPath: "/tmp/Companion.app/Contents/Resources")
        XCTAssertEqual(c.resourceURL("../Helpers/BailongPet.app", relativeTo: root).path,
                       "/tmp/Companion.app/Contents/Helpers/BailongPet.app")
    }
}

final class ExternalPetLaunchIntentTests: XCTestCase {
    func testCurrentShowMayReveal() {
        var intent = ExternalPetLaunchIntent()
        let token = intent.show()
        XCTAssertEqual(intent.resolve(token), .reveal)
    }
    func testHideDuringLaunchWins() {
        var intent = ExternalPetLaunchIntent()
        let token = intent.show(); intent.hide()
        XCTAssertEqual(intent.resolve(token), .hide)
    }
    func testOldCompletionMustNotHideNewerShow() {
        var intent = ExternalPetLaunchIntent()
        let old = intent.show(); intent.hide(); let current = intent.show()
        XCTAssertEqual(intent.resolve(old), .leaveAlone)
        XCTAssertEqual(intent.resolve(current), .reveal)
    }
}

final class LocalPetRevealTests: XCTestCase {
    func testMissingSocketRejected() {
        XCTAssertFalse(LocalPetReveal.connect(at: URL(fileURLWithPath: "/tmp/dragon-missing-\(UUID().uuidString)")))
    }
    func testRegularFileRejected() throws {
        let url = URL(fileURLWithPath: "/tmp/dragon-file-\(UUID().uuidString)")
        try Data("not a socket".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertFalse(LocalPetReveal.connect(at: url))
    }
    func testLocalSocketReceivesOnlyConnection() throws {
        let url = URL(fileURLWithPath: "/tmp/dragon-reveal-\(UUID().uuidString.prefix(8))")
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        defer { Darwin.close(descriptor); try? FileManager.default.removeItem(at: url) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(url.path.utf8) + [UInt8(0)]
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes + Array(repeating: 0, count: $0.count - bytes.count)) }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        } }
        XCTAssertEqual(bound, 0); XCTAssertEqual(listen(descriptor, 1), 0)
        _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
        XCTAssertTrue(LocalPetReveal.connect(at: url))
        let client = accept(descriptor, nil, nil)
        XCTAssertGreaterThanOrEqual(client, 0)
        if client >= 0 {
            defer { Darwin.close(client) }
            var byte: UInt8 = 0
            XCTAssertEqual(read(client, &byte, 1), 0, "唤回只能连接，不发送任意消息")
        }
    }
    func testOldRunningCompanionStatusStillDecodes() throws {
        let data = Data(#"{"ok":true,"message":"legacy","phase":"idle","paused":false,"petVisible":false,"backend":"native","posterReady":false}"#.utf8)
        let decoded = try JSONDecoder().decode(CompanionStatus.self, from: data)
        XCTAssertEqual(decoded.petState, "unknown"); XCTAssertNil(decoded.petError)
    }
    func testStatusIncludesPetError() throws {
        let status = CompanionStatus(message: "state", phase: "idle", codexPID: nil, paused: false,
                                     petVisible: false, backend: "external", posterReady: false,
                                     petState: "failed", petError: "missing asset")
        let decoded = try JSONDecoder().decode(CompanionStatus.self, from: JSONEncoder().encode(status))
        XCTAssertEqual(decoded.petState, "failed"); XCTAssertEqual(decoded.petError, "missing asset")
    }
}
