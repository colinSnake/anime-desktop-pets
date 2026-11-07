import Foundation
import XCTest
@testable import DragonCompanion

@MainActor
final class SpeechRuntimeSupervisorTests: XCTestCase {
    func testRuntimeFailureReasonsRemainStageSpecificWithoutRawDiagnostics() {
        let cases: [(String, String)] = [
            ("empty_transcription", "没有识别到有效语音"),
            ("transcription_failed", "本地语音识别失败"),
            ("model_load_failed", "模型加载失败"),
            ("reply_generation_failed", "文字回复生成失败"),
            ("synthesis_failed", "音色合成失败"),
            ("playback_failed", "扬声器"),
            ("output_device_failed", "扬声器"),
        ]
        for (reason, expected) in cases {
            XCTAssertTrue(SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: reason)
                .localizedDescription.contains(expected), reason)
        }
        XCTAssertEqual(SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: "private unknown detail")
            .localizedDescription, SpeechRuntimeSupervisor.SupervisorError.inferenceFailed.localizedDescription)
    }

    func testRejectsChatWhenCommandExceedsProtocolLimit() throws {
        let supervisor = SpeechRuntimeSupervisor(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"])
        try supervisor.start()
        defer { supervisor.terminateImmediately() }

        XCTAssertThrowsError(try supervisor.sendChat(platform: "bilibili", messageID: "", text: String(repeating: "中", count: 3000)))
    }

    func testTranscriptionEventIsDeliveredFromChildProcessOutput() async throws {
        let script = """
        printf '%s\\n' '{"protocol_version":1,"type":"ready"}'
        IFS= read -r command
        printf '%s\\n' '{"protocol_version":1,"type":"transcription","text":"你好，龙妹。"}'
        """
        let supervisor = SpeechRuntimeSupervisor(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", script]
        )
        let transcription = expectation(description: "ASR text reaches the host callback")
        let exited = expectation(description: "mock speech child exits")
        supervisor.onEvent = { event in
            if event.type == "ready" {
                try? supervisor.sendTranscription(audioURL: URL(fileURLWithPath: "/tmp/simulated-input.wav"))
            } else if event.type == "transcription" {
                XCTAssertEqual(event.text, "你好，龙妹。")
                transcription.fulfill()
            }
        }
        supervisor.onExit = { status in
            XCTAssertEqual(status, 0)
            exited.fulfill()
        }

        try supervisor.start()
        await fulfillment(of: [transcription], timeout: 3)
        await fulfillment(of: [exited], timeout: 3)
        XCTAssertFalse(supervisor.isRunning)
    }

    func testAdditionalArgumentsAreAppendedAfterConfiguredServiceScript() async throws {
        let script = "printf '{\"protocol_version\":1,\"type\":\"ready\",\"state\":\"%s\"}\\n' \"$1\""
        let supervisor = SpeechRuntimeSupervisor(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", script, "service-script"]
        )
        let ready = expectation(description: "configured script receives runtime options")
        supervisor.onEvent = { event in
            guard event.type == "ready" else { return }
            XCTAssertEqual(event.state, "--asr-model")
            ready.fulfill()
        }
        supervisor.onExit = { _ in }

        try supervisor.start(appendingArguments: ["--asr-model", "/models/asr"])
        await fulfillment(of: [ready], timeout: 3)
        supervisor.terminateImmediately()
    }

    func testWarmRuntimeIsReusedOnlyForMatchingModelConfiguration() throws {
        let supervisor = SpeechRuntimeSupervisor(executable: URL(fileURLWithPath: "/bin/sh"),
                                                 arguments: ["-c", "sleep 30", "service-script"])
        let modelArguments = ["--asr-model", "/models/asr", "--tts-model", "/models/tts"]
        try supervisor.start(appendingArguments: modelArguments)
        defer { supervisor.terminateImmediately() }

        XCTAssertTrue(supervisor.isRunning(withAdditionalArguments: modelArguments))
        XCTAssertFalse(supervisor.isRunning(withAdditionalArguments: ["--asr-model", "/models/other"]))
        XCTAssertThrowsError(try supervisor.start(appendingArguments: ["--asr-model", "/models/other"]))
    }

    func testForcedTerminationReportsExitAndReleasesProcess() async throws {
        let supervisor = SpeechRuntimeSupervisor(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"])
        let exited = expectation(description: "child process exits")
        supervisor.onExit = { _ in exited.fulfill() }

        try supervisor.start()
        XCTAssertTrue(supervisor.isRunning)
        supervisor.terminateImmediately()
        await fulfillment(of: [exited], timeout: 3)
        XCTAssertFalse(supervisor.isRunning)
    }

    func testCanRestartAfterTerminationCallback() async throws {
        let supervisor = SpeechRuntimeSupervisor(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"])
        let exited = expectation(description: "first child exits")
        supervisor.onExit = { _ in exited.fulfill() }

        try supervisor.start()
        supervisor.terminateImmediately()
        await fulfillment(of: [exited], timeout: 3)
        try supervisor.start()
        XCTAssertTrue(supervisor.isRunning)
        supervisor.terminateImmediately()
    }

    func testGracefulShutdownTimeoutForcesExitAndCompletesWaiter() async throws {
        let supervisor = SpeechRuntimeSupervisor(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"])
        let exited = expectation(description: "shutdown waiter completes")

        try supervisor.start()
        supervisor.shutdownGracefully(timeout: 0.01) { exited.fulfill() }
        await fulfillment(of: [exited], timeout: 3)
        XCTAssertFalse(supervisor.isRunning)
    }
}
