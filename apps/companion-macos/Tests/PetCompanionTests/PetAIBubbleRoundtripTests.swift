import Foundation
import PetCore
import XCTest
@testable import PetCompanion

/// 真实Swift生产handler与Python客户端之间的离线协议验收；只使用临时资料和假模型。
@MainActor
final class PetAIBubbleRoundtripTests: XCTestCase {
    private let generatedLine = "我在这里陪着你，慢慢来就好。"

    private func roundtrip(_ scenario: String, presentation: Bool = false) async throws {
        let root = URL(fileURLWithPath: "/tmp/pet-bubble-e2e-\(UUID().uuidString.prefix(10))")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let settings = SpeechSettingsStore(stateDirectory: root)
        if scenario != "disabled" {
            var value = SpeechSettings(); value.aiBubblesEnabled = true
            try settings.save(value)
        }
        var calls = 0
        var generationObservedFirstReturn = false
        let line = generatedLine
        let coordinator = Coordinator(runtime: Runtime(resources: root, state: root, configuration: .init()),
            mode: .previewPet, aiBubbleGenerator: { event in
                calls += 1
                XCTAssertEqual(event, .idle)
                // 确定性握手：choose()返回之后才允许模型完成，不能靠短sleep猜非阻塞。
                let returned = root.appendingPathComponent("first-choice-returned")
                let deadline = Date().addingTimeInterval(1)
                while !FileManager.default.fileExists(atPath: returned.path), Date() < deadline {
                    try await Task.sleep(nanoseconds: 2_000_000)
                }
                generationObservedFirstReturn = FileManager.default.fileExists(atPath: returned.path)
                XCTAssertTrue(generationObservedFirstReturn, "首次choose不得等待生成完成")
                guard generationObservedFirstReturn else { throw URLError(.timedOut) }
                if scenario == "failure" { throw URLError(.cannotConnectToHost) }
                if scenario == "revoked" {
                    var value = try settings.load()
                    value.aiBubblesEnabled = false; try settings.save(value)
                    value.aiBubblesEnabled = true; try settings.save(value)
                }
                return line
            })
        let socket = root.appendingPathComponent("control.sock")
        let productionHandler = ApplicationDelegate.makeControlHandler(coordinator: coordinator)
        var bubbleRequests = 0
        var spoken: [String] = []
        let server = try ControlSocket(url: socket) { request in
            if request.command == .bubble {
                bubbleRequests += 1
                XCTAssertNil(request.text, "气泡请求不能携带本地文案/聊天正文")
                XCTAssertEqual(request.event, "idle")
            }
            if request.command == .speak {
                XCTAssertNotNil(request.text)
                spoken.append(request.text ?? "")
                // 仅测试进程的合成回执；表示朗读入口收到文本，不冒充TTS实际合成。
                do {
                    try JSONEncoder().encode(spoken).write(to: root.appendingPathComponent("probe-speech-receipts.json"), options: .atomic)
                } catch { XCTFail("合成朗读回执写入失败：\(error)") }
            }
            return await productionHandler(request)
        }
        defer { withExtendedLifetime((coordinator, server)) {} }
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let output = try await Self.probe(repository: repository, state: root, scenario: scenario, presentation: presentation)
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: output) as? [String: Any])
        let local = "固定本地合成文案，不得发送给模型。"
        XCTAssertEqual(result["selections"] as? [String],
            [local, local, scenario == "success" ? generatedLine : local, local])
        if presentation {
            let expected = [local, scenario == "success" ? generatedLine : local, local]
            XCTAssertEqual(result["displayed"] as? [String], expected)
            XCTAssertEqual(spoken, expected, "Qt实际显示与真实朗读Socket入口必须同文、同序、无双播")
        } else { XCTAssertTrue(spoken.isEmpty) }
        XCTAssertEqual(result["workerStopped"] as? Bool, true)
        XCTAssertEqual(calls, scenario == "disabled" ? 0 : 1)
        XCTAssertEqual(generationObservedFirstReturn, scenario != "disabled")
        XCTAssertEqual(bubbleRequests, scenario == "disabled" ? 0 : 1)
        let budget = root.appendingPathComponent("ai-bubble-budget.json")
        if scenario == "disabled" {
            XCTAssertFalse(FileManager.default.fileExists(atPath: budget.path))
        } else {
            let saved = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: budget)) as? [String: Any])
            XCTAssertEqual(saved["attempts"] as? Int, 1)
        }
        let status = try await Task.detached { try ControlSocket.request(.status, at: socket) }.value
        XCTAssertTrue(status.ok, "生成/关闭客户端之后，普通控制命令仍须可用")
    }

    func testPythonConsumesProductionReplyExactlyOnceAndNeverSendsFallback() async throws {
        try await roundtrip("success")
    }

    func testPythonKeepsLocalFallbackAfterProductionFailureWithoutRetry() async throws {
        try await roundtrip("failure")
    }

    func testPythonDiscardsReplyAfterProductionConsentRotates() async throws {
        try await roundtrip("revoked")
    }

    func testPythonDefaultOffDoesNotReachProductionGeneratorOrBudget() async throws {
        try await roundtrip("disabled")
    }

    func testQtShowsAndAnnouncesProductionTextExactlyOnce() async throws {
        try await roundtrip("success", presentation: true)
    }

    func testQtShowsAndAnnouncesLocalTextOnProductionFailure() async throws {
        try await roundtrip("failure", presentation: true)
    }

    func testQtCannotPresentOrAnnounceRevokedProductionText() async throws {
        try await roundtrip("revoked", presentation: true)
    }

    private nonisolated static func probe(repository: URL, state: URL, scenario: String,
                                         presentation: Bool) async throws -> Data {
        let arguments = [repository.appendingPathComponent("scripts/fixtures/pet_ai_bubble_probe.py").path, state.path, scenario]
        let executable: URL
        let launchArguments: [String]
        if presentation {
            let python = repository.appendingPathComponent(".local/pet-build/venv/bin/python")
            let source = repository.appendingPathComponent(".local/pet-build/generated-source/app/pet.py")
            guard FileManager.default.isExecutableFile(atPath: python.path),
                  FileManager.default.fileExists(atPath: source.path) else {
                throw XCTSkip("Qt整链测试未执行：缺少已准备的运行时及合成素材适配入口")
            }
            executable = python
            launchArguments = arguments + ["--qt"]
        } else {
            executable = URL(fileURLWithPath: "/usr/bin/env")
            launchArguments = ["python3"] + arguments
        }
        let result = try await PetBubbleProbeProcess.run(executable: executable, arguments: launchArguments, state: state)
        guard !result.timedOut, result.terminationStatus == 0 else {
            let detail = String(decoding: result.diagnostics, as: UTF8.self)
            throw NSError(domain: "PetBubbleProbe", code: result.timedOut ? 1 : Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: (result.timedOut ? "离线Python整链探针超时；已确认回收。" : "") + detail])
        }
        return result.output
    }
}
