import Darwin
import Foundation

struct SpeechRuntimeEvent: Decodable, Equatable {
    let protocolVersion: Int
    let type: String
    let state: String?
    let reply: String?
    let text: String?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case type, state, reply, text, reason
    }
}

@MainActor
final class SpeechRuntimeSupervisor {
    var onEvent: ((SpeechRuntimeEvent) -> Void)?
    var onExit: ((Int32) -> Void)?

    private let executable: URL
    private let arguments: [String]
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var outputBuffer = Data()
    private var stoppingGracefully = false
    private var terminationRequested = false
    private var generation = UUID()
    private var runningAdditionalArguments: [String]?
    private var terminationWaiters: [() -> Void] = []

    var isRunning: Bool { process?.isRunning == true }
    var isStopping: Bool { stoppingGracefully || terminationRequested }
    private(set) var isReady = false
    var isTTSOnly: Bool { isRunning && runningAdditionalArguments?.contains("--tts-only") == true }

    func isRunning(withAdditionalArguments additionalArguments: [String]) -> Bool {
        isRunning && runningAdditionalArguments == additionalArguments
    }

    init(executable: URL, arguments: [String]) {
        self.executable = executable
        self.arguments = arguments
    }

    func start(appendingArguments additionalArguments: [String] = []) throws {
        if process?.isRunning == true {
            guard runningAdditionalArguments == additionalArguments else {
                throw SupervisorError.configurationChanged
            }
            return
        }
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw SupervisorError.executableUnavailable
        }

        let child = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        child.executableURL = executable
        child.arguments = arguments + additionalArguments
        // A child may close stdin while still running. Report EPIPE to the
        // caller instead of allowing SIGPIPE to terminate the desktop host.
        guard fcntl(stdinPipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            throw SupervisorError.notRunning
        }
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = stderrPipe
        let token = UUID()
        child.terminationHandler = { [weak self] process in
            Task { @MainActor in self?.didTerminate(process, generation: token, status: process.terminationStatus) }
        }

        generation = token
        isReady = false
        terminationRequested = false
        try child.run()
        process = child
        runningAdditionalArguments = additionalArguments
        input = stdinPipe.fileHandleForWriting
        output = stdoutPipe.fileHandleForReading
        outputBuffer.removeAll(keepingCapacity: true)
        stoppingGracefully = false
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            Task { @MainActor in self?.consume(data, generation: token) }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
    }

    func sendChat(platform: String, messageID: String, text: String) throws {
        try send(["type": "chat", "platform": platform, "message_id": messageID, "text": text])
    }

    func sendTranscription(audioURL: URL) throws {
        try send(["type": "transcribe", "audio_path": audioURL.path])
    }

    func sendResponse(text: String, speak: Bool) throws {
        try send(["type": "respond", "text": text, "speak": speak])
    }

    func ping() throws { try send(["type": "ping"]) }

    func shutdownGracefully(timeout: TimeInterval = 5, completion: (() -> Void)? = nil) {
        if let completion { terminationWaiters.append(completion) }
        guard let process, process.isRunning else {
            finishTerminationWaiters()
            return
        }
        guard !stoppingGracefully else { return }
        stoppingGracefully = true
        try? send(["type": "shutdown"])
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, timeout)) { [weak self, weak process] in
            guard let self, let process, process.isRunning,
                  self.process === process, self.generation == token else { return }
            fputs("Dragon: speech runtime did not stop gracefully; sending terminate.\n", stderr)
            // Immediate termination owns the single bounded SIGKILL fallback.
            self.terminateImmediately()
        }
    }

    func terminateImmediately(completion: (() -> Void)? = nil) {
        if let completion { terminationWaiters.append(completion) }
        guard let process, process.isRunning else {
            finishTerminationWaiters()
            return
        }
        terminationRequested = true
        process.terminate()
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak process] in
            guard let self, let process, process.isRunning,
                  self.process === process, self.generation == token else { return }
            fputs("Dragon: speech runtime ignored immediate termination; forcing owned child to exit.\n", stderr)
            _ = kill(process.processIdentifier, SIGKILL)
        }
    }

    func restart() throws {
        let additionalArguments = runningAdditionalArguments ?? []
        terminateImmediately()
        if process?.isRunning == true {
            throw SupervisorError.stillStopping
        }
        process = nil
        runningAdditionalArguments = nil
        try start(appendingArguments: additionalArguments)
    }

    private func send(_ command: [String: Any]) throws {
        guard isRunning, let input else { throw SupervisorError.notRunning }
        let data = try JSONSerialization.data(withJSONObject: command, options: [.sortedKeys])
        guard data.count <= 8192 else { throw SupervisorError.commandTooLarge }
        var line = data
        line.append(0x0A)
        try input.write(contentsOf: line)
    }

    private func consume(_ data: Data, generation token: UUID) {
        guard generation == token else { return }
        outputBuffer.append(data)
        guard outputBuffer.count <= 65536 else {
            terminateImmediately()
            return
        }
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer.prefix(upTo: newline)
            outputBuffer.removeSubrange(...newline)
            guard let event = try? JSONDecoder().decode(SpeechRuntimeEvent.self, from: Data(line)),
                  event.protocolVersion == 1 else { continue }
            if event.type == "ready" { isReady = true }
            onEvent?(event)
        }
    }

    private func didTerminate(_ child: Process, generation token: UUID, status: Int32) {
        guard process === child, generation == token else { return }
        input?.closeFile(); input = nil
        output?.readabilityHandler = nil; output?.closeFile(); output = nil
        process = nil
        isReady = false
        terminationRequested = false
        runningAdditionalArguments = nil
        outputBuffer.removeAll(keepingCapacity: false)
        stoppingGracefully = false
        let waiters = terminationWaiters
        terminationWaiters.removeAll()
        onExit?(status)
        waiters.forEach { $0() }
    }

    private func finishTerminationWaiters() {
        let waiters = terminationWaiters
        terminationWaiters.removeAll()
        waiters.forEach { $0() }
    }

    enum SupervisorError: LocalizedError {
        case executableUnavailable
        case notRunning
        case commandTooLarge
        case stillStopping
        case configurationChanged
        case referenceUnavailable
        case modelsUnavailable
        case emptyTranscription
        case transcriptionFailed
        case inferenceFailed
        case modelLoadFailed
        case replyGenerationFailed
        case synthesisFailed
        case playbackFailed
        case cancelled
        case turnTimedOut
        case unexpectedExit

        static func runtimeFailure(reason: String?) -> SupervisorError {
            switch reason {
            case "empty_transcription": .emptyTranscription
            case "transcription_failed": .transcriptionFailed
            case "model_load_failed": .modelLoadFailed
            case "reply_generation_failed": .replyGenerationFailed
            case "synthesis_failed": .synthesisFailed
            case "playback_failed", "output_device_failed": .playbackFailed
            default: .inferenceFailed
            }
        }

        var errorDescription: String? {
            switch self {
            case .executableUnavailable: "语音运行时解释器不可执行。"
            case .notRunning: "语音运行时尚未启动。"
            case .commandTooLarge: "语音命令超过8KiB限制。"
            case .stillStopping: "语音运行时正在退出；请等待退出事件后再重启。"
            case .configurationChanged: "语音设置与已加载的模型配置不同；请正常退出并重新打开桌边小崽后再试。"
            case .referenceUnavailable: "参考音频不可读或安全访问授权已失效；请重新选择音频。"
            case .modelsUnavailable: "本地 ASR/TTS 语音模型目录不完整。"
            case .emptyTranscription: "没有识别到有效语音；请靠近麦克风并清楚地说一句话后重试。"
            case .transcriptionFailed: "本地语音识别失败；录音格式或 ASR 模型处理失败。"
            case .modelLoadFailed: "本地语音模型加载失败；请检查模型完整性和可用内存。"
            case .replyGenerationFailed: "语音已识别，但文字回复生成失败。"
            case .synthesisFailed: "文字回复已生成，但音色合成失败；请检查参考音频和准确转写。"
            case .cancelled: "本轮语音已取消。"
            case .turnTimedOut: "语音处理超过本轮时限，已停止本轮服务；请重试或检查本机模型和输出设备。"
            case .unexpectedExit: "语音服务在回复完成前退出，本轮已结束；请重试。"
            case .playbackFailed: "扬声器初始化或播放失败；请检查系统声音输出设备，也可关闭朗读后重试。"
            case .inferenceFailed: "本地语音生成失败；请检查模型、转写和参考音频。"
            }
        }
    }
}
