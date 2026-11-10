import AppKit
import Darwin
import DragonCore
import Foundation
import XCTest
@testable import DragonCompanion

@MainActor
final class SpeechWarmupTests: XCTestCase {
    private struct Fixture {
        let root: URL
        let runtime: Runtime
        let bin: URL
        var commands: [String] {
            ((try? String(contentsOf: bin.appendingPathComponent("commands.jsonl"))) ?? "")
                .split(separator: "\n").map(String.init)
        }
        var starts: Int {
            ((try? String(contentsOf: bin.appendingPathComponent("starts"))) ?? "")
                .split(separator: "\n").count
        }
        var stops: Int {
            ((try? String(contentsOf: bin.appendingPathComponent("stops"))) ?? "")
                .split(separator: "\n").count
        }
        var completedCues: Int {
            ((try? String(contentsOf: bin.appendingPathComponent("completed-cues"))) ?? "")
                .split(separator: "\n").count
        }
    }

    private func fixture(enabled: Bool = true, loading: String = "sleep 0.15",
                         speaking: String = "") throws -> Fixture {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("speech-warmup-\(UUID().uuidString)")
        let bin = root.appendingPathComponent(".local/voice-runtime/venv/bin")
        let script = root.appendingPathComponent("apps/speech-runtime/stdio_service.py")
        let state = root.appendingPathComponent("state")
        let model = root.appendingPathComponent(".local/voice-runtime/models/Qwen3-TTS-12Hz-0.6B-Base-8bit")
        for path in [bin, script.deletingLastPathComponent(), state, model] {
            try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
        }
        try Data().write(to: script)
        // This shell fixture never loads models or opens an audio device.
        let executable = """
        #!/bin/sh
        record="$(dirname "$0")"
        trap 'printf "%s\\n" stop >> "$record/stops"' EXIT
        printf '%s\\n' start >> "$record/starts"
        printf '%s\\n' "$@" > "$record/arguments"
        \(loading)
        printf '%s\\n' '{"protocol_version":1,"type":"ready"}'
        while IFS= read -r command; do
            case "$command" in
                *shutdown*) printf '%s\\n' stop >> "$record/stops"; exit 0 ;;
                *respond*)
                    printf '%s\\n' "$command" >> "$record/commands.jsonl"
                    \(speaking)
                    printf '%s\\n' '{"protocol_version":1,"type":"session","state":"idle"}'
                    printf '%s\\n' done >> "$record/completed-cues" ;;
            esac
        done
        """
        let python = bin.appendingPathComponent("python")
        try executable.write(to: python, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: python.path)
        let reference = root.appendingPathComponent("synthetic-reference.wav")
        try Data("not an audio recording; fixture only".utf8).write(to: reference)
        var settings = SpeechSettings()
        settings.speakInteractiveBubbles = enabled
        var stale = false
        let bookmark = try reference.bookmarkData(options: .withSecurityScope,
                                                   includingResourceValuesForKeys: nil, relativeTo: nil)
        let resolved = try URL(resolvingBookmarkData: bookmark, options: .withSecurityScope,
                               relativeTo: nil, bookmarkDataIsStale: &stale)
        XCTAssertFalse(stale)
        settings.referenceAudioPath = resolved.path
        settings.referenceAudioBookmark = bookmark
        settings.referenceTranscript = "合成测试参考"
        try SpeechSettingsStore(stateDirectory: state).save(settings)
        return Fixture(root: root, runtime: Runtime(resources: root.appendingPathComponent("resources"),
                                                   state: state, configuration: .init()), bin: bin)
    }

    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while !condition() && ProcessInfo.processInfo.systemUptime < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func stop(_ coordinator: Coordinator) async {
        coordinator.stop()
        let stopped = expectation(description: "owned mock speech process stops")
        coordinator.finishStopping { stopped.fulfill() }
        await fulfillment(of: [stopped], timeout: 3)
    }

    private func withRepository(_ root: URL, body: () async throws -> Void) async rethrows {
        let original = ProcessInfo.processInfo.environment["DRAGON_DEV_ROOT"]
        setenv("DRAGON_DEV_ROOT", root.path, 1)
        defer {
            if let original { setenv("DRAGON_DEV_ROOT", original, 1) }
            else { unsetenv("DRAGON_DEV_ROOT") }
        }
        try await body()
    }

    func testRuntimeFailureReleasesCueAndNextClickStartsFreshProcess() async throws {
        let f = try fixture(speaking: "printf '%s\\n' '{\"protocol_version\":1,\"type\":\"session\",\"state\":\"error\",\"reason\":\"playback_failed\"}'")
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            _ = coordinator.handle(.init(.speak, text: "首次设备故障"))
            try await waitUntil { f.commands.count == 1 && !coordinator.isSpeechRuntimeRunning }
            _ = coordinator.handle(.init(.speak, text: "设备恢复后重试"))
            try await waitUntil { f.commands.count == 2 && !coordinator.isSpeechRuntimeRunning }
            XCTAssertEqual(f.starts, 2)
            await stop(coordinator)
        }
    }

    func testStalledCueDeadlineStopsOwnedProcessAndAllowsAnotherCue() async throws {
        // Block on stdin without burning CPU. Only the first child stalls;
        // it consumes shutdown but ignores TERM, exercising the owned-child kill.
        let f = try fixture(loading: "", speaking: """
        if [ ! -f "$record/stalled" ]; then
            touch "$record/stalled"
            trap '' TERM
            while IFS= read -r ignored; do :; done
        fi
        """)
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest, speechTurnTimeout: 0.08)
            var ready = false
            coordinator.prewarmInteractiveSpeech { ready = true }
            try await waitUntil { ready }
            _ = coordinator.handle(.init(.speak, text: "合成卡住的提示"))
            try await waitUntil { f.commands.count == 1 && !coordinator.isSpeechRuntimeRunning }
            XCTAssertEqual(f.completedCues, 0, "a timed-out cue cannot report successful playback")
            ready = false
            coordinator.prewarmInteractiveSpeech { ready = true }
            try await waitUntil { ready }
            _ = coordinator.handle(.init(.speak, text: "超时后下一条提示"))
            try await waitUntil { f.commands.count == 2 && f.completedCues == 1 }
            XCTAssertEqual(f.starts, 2)
            XCTAssertTrue(coordinator.isSpeechRuntimeRunning, "the replacement child remains ready")
            await stop(coordinator)
        }
    }

    func testWarmupLoadsBeforeCompletionAndFirstCueReusesProcessExactlyOnce() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var completed = false
            coordinator.prewarmInteractiveSpeech { completed = true }
            XCTAssertFalse(completed, "must wait for the child's ready event")
            try await waitUntil { completed }
            XCTAssertEqual(f.starts, 1)
            XCTAssertEqual(f.commands, [], "warmup must never synthesize or speak")
            let arguments = try String(contentsOf: f.bin.appendingPathComponent("arguments"))
            XCTAssertTrue(arguments.contains("--tts-only\n"))
            _ = coordinator.handle(.init(.speak, text: "第一次点击"))
            try await waitUntil { f.commands.count == 1 }
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(f.starts, 1, "first cue must reuse the preloaded process")
            XCTAssertEqual(f.commands.count, 1)
            await stop(coordinator)
        }
    }

    func testClickDuringWarmupKeepsOnlyLatestCueAndWaitsForReady() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var completed = false
            coordinator.prewarmInteractiveSpeech { completed = true }
            _ = coordinator.handle(.init(.speak, text: "旧点击"))
            _ = coordinator.handle(.init(.speak, text: "最新点击"))
            XCTAssertEqual(f.commands, [])
            try await waitUntil { completed && f.commands.count == 1 }
            XCTAssertTrue(f.commands.first?.contains("最新点击") == true)
            XCTAssertEqual(f.starts, 1)
            await stop(coordinator)
        }
    }

    func testChangedReferenceRestartsAndPreservesFirstCueExactlyOnce() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var completed = false
            coordinator.prewarmInteractiveSpeech { completed = true }
            try await waitUntil { completed }
            let store = SpeechSettingsStore(stateDirectory: f.runtime.state)
            var settings = try store.load()
            settings.referenceTranscript = "新的合成测试参考"
            try store.save(settings)
            _ = coordinator.handle(.init(.speak, text: "更换配置后第一次点击"))
            try await waitUntil { f.commands.count == 1 }
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(f.starts, 2)
            XCTAssertEqual(f.commands.count, 1)
            XCTAssertTrue(f.commands.first?.contains("更换配置后第一次点击") == true)
            await stop(coordinator)
        }
    }

    func testRepeatedReferenceChangesDuringShutdownWarmLatestSettingsOnce() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var ready = false
            coordinator.prewarmInteractiveSpeech { ready = true }
            try await waitUntil { ready }
            let store = SpeechSettingsStore(stateDirectory: f.runtime.state)
            var settings = try store.load()
            var completions = 0
            for transcript in ["参考版本二", "参考版本三", "最终参考转写"] {
                settings.referenceTranscript = transcript
                try store.save(settings)
                coordinator.interactiveSpeechSettingsDidChange(settings) { completions += 1 }
                _ = coordinator.handle(.init(.speak, text: transcript))
            }
            try await waitUntil { completions == 3 && f.completedCues == 1 }
            XCTAssertEqual(f.starts, 2, "concurrent restart requests must start one replacement")
            XCTAssertEqual(f.commands.count, 1)
            XCTAssertTrue(f.commands.first?.contains("最终参考转写") == true)
            let arguments = try String(contentsOf: f.bin.appendingPathComponent("arguments"))
            XCTAssertTrue(arguments.contains("最终参考转写"))
            await stop(coordinator)
        }
    }

    func testReferenceChangedDuringCueRewarmsBeforeSubmittingPendingCue() async throws {
        let f = try fixture(speaking: "sleep 0.3")
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var ready = false
            coordinator.prewarmInteractiveSpeech { ready = true }
            try await waitUntil { ready }
            _ = coordinator.handle(.init(.speak, text: "旧参考朗读"))
            try await waitUntil { f.commands.count == 1 }
            let store = SpeechSettingsStore(stateDirectory: f.runtime.state)
            var settings = try store.load()
            settings.referenceTranscript = "新参考转写"
            try store.save(settings)
            coordinator.interactiveSpeechSettingsDidChange(settings)
            _ = coordinator.handle(.init(.speak, text: "新参考朗读"))
            try await waitUntil { f.completedCues == 2 }
            XCTAssertEqual(f.starts, 2)
            XCTAssertEqual(f.commands.count, 2)
            XCTAssertTrue(f.commands.last?.contains("新参考朗读") == true)
            let arguments = try String(contentsOf: f.bin.appendingPathComponent("arguments"))
            XCTAssertTrue(arguments.contains("新参考转写"))
            await stop(coordinator)
        }
    }

    func testQuitDuringConfigurationRestartNeverLaunchesReplacementChild() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var completed = false
            coordinator.prewarmInteractiveSpeech { completed = true }
            try await waitUntil { completed }
            let store = SpeechSettingsStore(stateDirectory: f.runtime.state)
            var settings = try store.load()
            settings.referenceTranscript = "退出测试参考"
            try store.save(settings)
            _ = coordinator.handle(.init(.speak, text: "退出时不应朗读"))
            await stop(coordinator)
            XCTAssertEqual(f.starts, 1)
            XCTAssertEqual(f.commands, [])
        }
    }

    func testBubbleRuntimeHandsOffToConversationDuringLoadingAndAfterReady() async throws {
        for waitForReady in [false, true] {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            try await withRepository(f.root) {
                let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
                var warmupCompleted = false
                coordinator.prewarmInteractiveSpeech { warmupCompleted = true }
                try await waitUntil { f.starts == 1 }
                if waitForReady { try await waitUntil { warmupCompleted } }
                var handoff: Result<Void, Error>?
                coordinator.prepareConversationSpeechRuntime { handoff = $0 }
                try await waitUntil { handoff != nil }
                try XCTUnwrap(handoff).get()
                XCTAssertTrue(warmupCompleted, "startup gate must be released before conversation starts")
                XCTAssertEqual(f.commands, [], "handoff never synthesizes speech")
                // The next bubble must launch a new process, proving the previous
                // TTS-only process was fully released rather than reused as ASR.
                _ = coordinator.handle(.init(.speak, text: "交接后点击"))
                try await waitUntil { f.commands.count == 1 }
                XCTAssertEqual(f.starts, 2)
                await stop(coordinator)
            }
        }
    }

    func testDisabledSpeechAndMissingModelsDoNotStartProcess() async throws {
        for enabled in [false, true] {
            let f = try fixture(enabled: enabled)
            defer { try? FileManager.default.removeItem(at: f.root) }
            if enabled {
                try FileManager.default.removeItem(at: f.root.appendingPathComponent(".local/voice-runtime/models"))
            }
            await withRepository(f.root) {
                let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
                var completed = false
                coordinator.prewarmInteractiveSpeech { completed = true }
                XCTAssertTrue(completed)
                XCTAssertEqual(f.starts, 0)
                await stop(coordinator)
            }
        }
    }

    func testDisablingSpeechDuringWarmupStopsTheModelProcess() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var gateReleased = false
            coordinator.prewarmInteractiveSpeech { gateReleased = true }
            try await waitUntil { f.starts == 1 }
            var settings = try SpeechSettingsStore(stateDirectory: f.runtime.state).load()
            settings.speakInteractiveBubbles = false
            try SpeechSettingsStore(stateDirectory: f.runtime.state).save(settings)
            coordinator.interactiveSpeechSettingsDidChange(settings)
            try await waitUntil { gateReleased && !coordinator.isSpeechRuntimeRunning }
            XCTAssertEqual(f.starts, 1)
            XCTAssertTrue(f.commands.isEmpty)
            await stop(coordinator)
        }
    }

    func testReenablingDuringShutdownWaitsAndStartsFreshWarmup() async throws {
        let f = try fixture(loading: "sleep 0.25")
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            coordinator.prewarmInteractiveSpeech {}
            try await waitUntil { f.starts == 1 }
            let store = SpeechSettingsStore(stateDirectory: f.runtime.state)
            var settings = try store.load()
            settings.speakInteractiveBubbles = false
            try store.save(settings)
            coordinator.interactiveSpeechSettingsDidChange(settings)
            settings.speakInteractiveBubbles = true
            try store.save(settings)
            var reenabledWarmupCompleted = false
            coordinator.interactiveSpeechSettingsDidChange(settings) {
                reenabledWarmupCompleted = true
            }
            _ = coordinator.handle(.init(.speak, text: "重新开启期间点击"))
            try await waitUntil { reenabledWarmupCompleted }
            XCTAssertEqual(f.starts, 2, "re-enable must not treat the stopping process as a warm runtime")
            XCTAssertEqual(f.stops, 1)
            try await waitUntil { f.commands.count == 1 }
            XCTAssertTrue(f.commands.first?.contains("重新开启期间点击") == true)
            await stop(coordinator)
        }
    }

    func testDisablingDuringSpeechStopsAfterCurrentCueAndDropsLaterCues() async throws {
        let f = try fixture(speaking: "sleep 0.3")
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var gateReleased = false
            coordinator.prewarmInteractiveSpeech { gateReleased = true }
            try await waitUntil { gateReleased }
            _ = coordinator.handle(.init(.speak, text: "正在朗读的合成 cue"))
            try await waitUntil { f.commands.count == 1 }
            var settings = try SpeechSettingsStore(stateDirectory: f.runtime.state).load()
            settings.speakInteractiveBubbles = false
            try SpeechSettingsStore(stateDirectory: f.runtime.state).save(settings)
            coordinator.interactiveSpeechSettingsDidChange(settings)
            _ = coordinator.handle(.init(.speak, text: "关闭后不应朗读"))
            try await waitUntil { !coordinator.isSpeechRuntimeRunning }
            XCTAssertEqual(f.commands.count, 1)
            await stop(coordinator)
        }
    }

    func testReenablingDuringSpeechKeepsRuntimeWarmForNextCue() async throws {
        let f = try fixture(speaking: "sleep 0.3")
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            coordinator.prewarmInteractiveSpeech {}
            try await waitUntil { coordinator.isSpeechRuntimeRunning }
            _ = coordinator.handle(.init(.speak, text: "正在朗读的合成 cue"))
            try await waitUntil { f.commands.count == 1 }

            let store = SpeechSettingsStore(stateDirectory: f.runtime.state)
            var settings = try store.load()
            settings.speakInteractiveBubbles = false
            try store.save(settings)
            coordinator.interactiveSpeechSettingsDidChange(settings)
            settings.speakInteractiveBubbles = true
            try store.save(settings)
            var reenabled = false
            coordinator.interactiveSpeechSettingsDidChange(settings) { reenabled = true }
            XCTAssertTrue(reenabled)

            try await waitUntil { f.completedCues == 1 }
            _ = coordinator.handle(.init(.speak, text: "重新开启后的下一条 cue"))
            try await waitUntil { f.commands.count == 2 && f.completedCues == 2 }
            XCTAssertEqual(f.starts, 1, "re-enable after an in-flight cue must reuse the ready TTS process")
            XCTAssertTrue(f.commands.last?.contains("重新开启后的下一条 cue") == true)
            await stop(coordinator)
        }
    }

    func testFinishedCueDoesNotRetainCoordinatorAfterShutdown() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            var coordinator: Coordinator? = Coordinator(runtime: f.runtime, mode: .controlTest)
            weak var releasedCoordinator = coordinator
            var ready = false
            coordinator?.prewarmInteractiveSpeech { ready = true }
            try await waitUntil { ready }
            _ = coordinator?.handle(.init(.speak, text: "内存释放测试"))
            try await waitUntil { f.completedCues == 1 }
            await stop(try XCTUnwrap(coordinator))
            coordinator = nil
            try await waitUntil { releasedCoordinator == nil }
        }
    }

    func testTimeoutReleasesStartupAndLateReadySubmitsQueuedCueOnce() async throws {
        let f = try fixture(loading: "sleep 0.25")
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await withRepository(f.root) {
            let coordinator = Coordinator(runtime: f.runtime, mode: .controlTest)
            var completions = 0
            coordinator.prewarmInteractiveSpeech(timeout: 0.03) { completions += 1 }
            try await waitUntil { completions == 1 }
            _ = coordinator.handle(.init(.speak, text: "超时后点击"))
            XCTAssertEqual(f.commands, [])
            try await waitUntil { f.commands.count == 1 }
            XCTAssertEqual(completions, 1)
            XCTAssertEqual(f.starts, 1)
            await stop(coordinator)
        }
    }

    func testFailedLoadReleasesStartupAndStopCancelsLateCompletion() async throws {
        let failed = try fixture(loading: "exit 1")
        defer { try? FileManager.default.removeItem(at: failed.root) }
        try await withRepository(failed.root) {
            let coordinator = Coordinator(runtime: failed.runtime, mode: .controlTest)
            var completed = false
            coordinator.prewarmInteractiveSpeech { completed = true }
            try await waitUntil { completed }
            XCTAssertEqual(failed.commands, [])
            await stop(coordinator)
        }
        let slow = try fixture(loading: "sleep 0.15")
        defer { try? FileManager.default.removeItem(at: slow.root) }
        await withRepository(slow.root) {
            let coordinator = Coordinator(runtime: slow.runtime, mode: .controlTest)
            var completed = false
            coordinator.prewarmInteractiveSpeech { completed = true }
            await stop(coordinator)
            XCTAssertFalse(completed, "quitting during warmup must never show a pet later")
        }
    }
}
