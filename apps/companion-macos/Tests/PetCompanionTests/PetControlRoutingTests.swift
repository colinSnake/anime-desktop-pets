import Foundation
import PetCore
import XCTest
@testable import PetCompanion

@MainActor
final class PetControlRoutingTests: XCTestCase {
    func testProductionHandlerAwaitsBubbleGenerationOverRealLocalSocket() async throws {
        let root = URL(fileURLWithPath: "/tmp/pet-router-\(UUID().uuidString.prefix(10))")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var settings = SpeechSettings(); settings.aiBubblesEnabled = true
        try SpeechSettingsStore(stateDirectory: root).save(settings)
        var generated = 0
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()),
            mode: .previewPet, aiBubbleGenerator: { event in
                generated += 1
                XCTAssertEqual(event, .idle)
                return "陪你安静坐一会儿。"
            })
        let socket = root.appendingPathComponent("control.sock")
        let server = try ControlSocket(url: socket, handler: ApplicationDelegate.makeControlHandler(coordinator: coordinator))
        defer { withExtendedLifetime((coordinator, server)) {} }
        let result = try await Task.detached {
            try ControlSocket.request(ControlRequest(.bubble, event: "idle"), at: socket)
        }.value
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.message, "陪你安静坐一会儿。")
        XCTAssertEqual(generated, 1)
        let status = try await Task.detached { try ControlSocket.request(.status, at: socket) }.value
        XCTAssertTrue(status.ok)
    }

    func testProductionHandlerRejectsUnconsentedBubbles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()),
            mode: .previewPet, aiBubbleGenerator: { _ in XCTFail("未授权不得生成"); return "不可用" })
        let handler = ApplicationDelegate.makeControlHandler(coordinator: coordinator)
        let result = await handler(ControlRequest(.bubble, event: "idle"))
        XCTAssertFalse(result.ok)
    }
}
