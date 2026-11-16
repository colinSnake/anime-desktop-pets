import Darwin
import Foundation

/// 只管理测试自己创建的子进程；与正常桌宠和用户任务无关。
enum PetBubbleProbeProcess {
    struct Result: Sendable {
        let output: Data
        let diagnostics: Data
        let terminationStatus: Int32
        let processID: Int32
        let timedOut: Bool
        let escalated: Bool
    }

    static func environment(inherited: [String: String], state: URL) -> [String: String] {
        // 白名单，而非在用户环境上删几个键：禁止租约、真实素材、Python注入及凭证继承。
        ["PATH": inherited["PATH"] ?? "/usr/bin:/bin:/opt/homebrew/bin",
         "LANG": "en_US.UTF-8", "HOME": state.path, "TMPDIR": "/tmp/",
         "CODEX_HOME": state.appendingPathComponent("synthetic-codex").path,
         "BAILONG_DATA_DIR": state.path, "BAILONG_CODEX": "/usr/bin/false",
         "BAILONG_PET_LIBRARY_DIR": state.appendingPathComponent("empty-pet-library").path,
         "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"]
    }

    static func run(executable: URL, arguments: [String], state: URL, timeout: TimeInterval = 15,
                    inheritedEnvironment: [String: String] = ProcessInfo.processInfo.environment,
                    fixturePhase: String? = nil) async throws -> Result {
        try await Task.detached {
            let outputURL = state.appendingPathComponent("probe-\(UUID()).stdout")
            let errorURL = state.appendingPathComponent("probe-\(UUID()).stderr")
            for url in [outputURL, errorURL] {
                guard FileManager.default.createFile(atPath: url.path, contents: Data(),
                    attributes: [.posixPermissions: 0o600]) else {
                    throw CocoaError(.fileWriteUnknown)
                }
            }
            let output = try FileHandle(forWritingTo: outputURL)
            defer { try? output.close() }
            let errors = try FileHandle(forWritingTo: errorURL)
            defer { try? errors.close() }
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            var isolated = environment(inherited: inheritedEnvironment, state: state)
            // 仅调用方显式指定的合成XCTest阶段可进入探针；不继承用户同名变量。
            isolated["PET_SYNTHETIC_XCTEST_PHASE"] = fixturePhase
            process.environment = isolated
            // 临时文件不受Pipe容量限制；Qt诊断再多也不阻塞子进程退出。
            process.standardOutput = output; process.standardError = errors
            try process.run()
            let identifier = process.processIdentifier
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            let timedOut = process.isRunning
            var escalated = false
            if timedOut {
                process.terminate()
                let grace = Date().addingTimeInterval(0.5)
                while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.01) }
                if process.isRunning {
                    // 仅对上面Process.run创建、尚未回收的测试探针升级；绝不按名称杀进程。
                    guard Darwin.kill(identifier, SIGKILL) == 0 || errno == ESRCH else {
                        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                    }
                    escalated = true
                }
            }
            // 超时也必须回收之后才向调用方返回，外层此后才能删除资料/关闭Socket。
            process.waitUntilExit()
            func readBounded(_ url: URL) throws -> Data {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                return try handle.read(upToCount: 1_048_576) ?? Data()
            }
            return try Result(output: readBounded(outputURL), diagnostics: readBounded(errorURL),
                terminationStatus: process.terminationStatus, processID: identifier,
                timedOut: timedOut, escalated: escalated)
        }.value
    }
}
