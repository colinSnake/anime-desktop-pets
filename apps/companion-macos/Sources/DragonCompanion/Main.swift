import AppKit
import ApplicationServices
import AVFoundation
import DragonCore
import Foundation
import ImageIO

@MainActor
final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    let runtime: Runtime
    let mode: Coordinator.Mode
    private var lock: InstanceLock?
    private var server: ControlSocket?
    private var coordinator: Coordinator?
    private var terminating = false
    private var terminationReplySent = false
    private var terminationTimeout: Timer?
    private(set) var exitStatus: Int32 = 0
    init(runtime: Runtime, mode: Coordinator.Mode) { self.runtime = runtime; self.mode = mode }
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            lock = try InstanceLock(url: runtime.state.appendingPathComponent("instance.lock"))
            let coordinator = Coordinator(runtime: runtime, mode: mode)
            self.coordinator = coordinator
            server = try ControlSocket(url: runtime.socketURL) { [weak coordinator] request in
                coordinator?.handle(request) ?? CompanionStatus(ok: false, message: "控制器已退出", phase: "idle", codexPID: nil, paused: true, petVisible: false, backend: "none", posterReady: false)
            }
            coordinator.start()
        } catch {
            fputs("Dragon: \(error.localizedDescription)\n", stderr)
            exitStatus = 1; NSApp.terminate(nil)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { mode == .previewCharacterWindow }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let coordinator else { return .terminateNow }
        guard !terminating else { return .terminateLater }
        terminating = true
        let timeout = Timer(timeInterval: 16, repeats: false) { [weak self, weak sender] _ in
            MainActor.assumeIsolated {
                guard let self, let sender, !self.terminationReplySent else { return }
                self.terminationReplySent = true
                self.terminationTimeout = nil
                fputs("Dragon: shutdown exceeded 16 seconds; allowing host application to exit.\n", stderr)
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        terminationTimeout = timeout
        RunLoop.main.add(timeout, forMode: .common)
        // AppKit re-enters the run loop in event-tracking mode while waiting
        // for terminateLater. A timer in common/default modes alone can never
        // fire here, leaving the agent stuck even after its children exit.
        RunLoop.main.add(timeout, forMode: .eventTracking)
        coordinator.stop()
        coordinator.finishStopping {
            guard !self.terminationReplySent else { return }
            self.terminationReplySent = true
            self.terminationTimeout?.invalidate()
            self.terminationTimeout = nil
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        if !terminating { coordinator?.stop() }
        server = nil; lock = nil
    }
}

@main
struct DragonCompanionMain {
    @MainActor static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        if args.contains("--help") || args.contains("-h") {
            print("""
            \(AppCopy.name) · Anime Desktop Pets
            \(AppCopy.tagline)
            --launch                 启动/复用 Codex（默认）；只对新进程播放动画
            --watch                  监视后续 Codex 启动；已有 Codex 只显示桌宠
            --preview-animation      只预览本地动画，不启动或激活 Codex
            --preview-pet            只预览桌宠，不读取 Codex 任务
            --preview-character-window 只打开角色、记忆与聊天窗口，不启动桌宠或在线服务
            --check                  静态检查配置、素材及客户端，不启动任何窗口/服务
            --status / --show / --hide / --dismiss / --pause / --resume / --quit
                                     通过本机 Socket 控制现有实例
            --control-test-server    仅供隔离测试；无窗口、无 Codex 观察器
            环境：DRAGON_DATA_DIR、DRAGON_RESOURCE_DIR
            """)
            return
        }
        let commands = Set(["--launch", "--watch", "--preview-animation", "--preview-pet", "--preview-character-window", "--check", "--control-test-server"] + ControlCommand.allCases.map { "--" + $0.rawValue })
        guard args.allSatisfy({ commands.contains($0) }), args.count <= 1 else {
            fputs("一次只能传入一个已知命令，使用 --help 查看用法。\n", stderr); exit(2)
        }
        // Validate before Runtime.load(), which can migrate the default user directory.
        if args.contains("--preview-character-window"),
           ProcessInfo.processInfo.environment["DRAGON_DATA_DIR"]?
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            fputs("离线角色预览需要隔离目录；请使用 scripts/preview-character.sh。\n", stderr)
            exit(2)
        }
        do {
            let runtime = try Runtime.load()
            if let arg = args.first, let command = ControlCommand(rawValue: String(arg.dropFirst(2))) {
                let response = try ControlSocket.request(command, at: runtime.socketURL)
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                print(String(decoding: try encoder.encode(response), as: UTF8.self))
                if !response.ok { exit(1) }
                return
            }
            if args.contains("--check") {
                let ok = await check(runtime)
                if !ok { exit(1) }
                return
            }
            let mode: Coordinator.Mode = args.contains("--watch") ? .watch
                : args.contains("--preview-animation") ? .previewAnimation
                : args.contains("--preview-pet") ? .previewPet
                : args.contains("--preview-character-window") ? .previewCharacterWindow
                : args.contains("--control-test-server") ? .controlTest : .launch
            runApplication(runtime, mode: mode)
        } catch { fputs("Dragon: \(error.localizedDescription)\n", stderr); exit(1) }
    }

    @MainActor private static func runApplication(_ runtime: Runtime, mode: Coordinator.Mode) {
        let app = NSApplication.shared
        app.setActivationPolicy(mode == .controlTest ? .prohibited : .regular)
        let delegate = ApplicationDelegate(runtime: runtime, mode: mode)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
        if delegate.exitStatus != 0 { exit(delegate.exitStatus) }
    }

    @MainActor private static func check(_ runtime: Runtime) async -> Bool {
        var checks: [String: Any] = ["configuration": "valid", "theme": "disabled; awaiting original poster and explicit compatibility verification", "taskStatus": runtime.configuration.taskFollowingEnabled ? "local rollout following enabled for enhanced helper in launch/watch; check does not read sessions" : "disabled by configuration", "petBackend": runtime.configuration.petBackend]
        var ok = true
        checks["startupWindowSizing"] = AXIsProcessTrusted() ? "authorized; new launch only" : "accessibility permission required; video fills actual client frame without resizing"
        checks["startupContentReadiness"] = "not observable; visible window is not proof that client loading finished"
        do {
            let url = try runtime.codexURL()
            checks["codexApp"] = url.path
            checks["startupLaunchArguments"] = runtime.startupLaunchArguments(at: url)
        }
        catch { checks["codexApp"] = error.localizedDescription; ok = false }
        do {
            let asset = AVURLAsset(url: runtime.videoURL)
            let duration = try await asset.load(.duration).seconds
            let playable = try await asset.load(.isPlayable)
            let tracks = try await asset.loadTracks(withMediaType: .video)
            guard duration.isFinite, duration > runtime.configuration.transitionEnd, playable, !tracks.isEmpty else {
                throw ConfigurationError("视频不可播放或短于淡出结束点")
            }
            checks["videoDuration"] = duration; checks["video"] = "playable"
        } catch { checks["video"] = error.localizedDescription; ok = false }
        if runtime.configuration.petBackend == "native" {
            if let source = CGImageSourceCreateWithURL(runtime.petURL as CFURL, nil), CGImageSourceGetCount(source) > 0 {
                checks["petFrames"] = CGImageSourceGetCount(source)
                checks["pet"] = "reference image; idle breathing; not the upstream 25-action set"
            } else { checks["pet"] = "missing image"; ok = false }
        } else {
            do {
                let descriptor = try ExternalPetDescriptor.inspect(runtime)
                checks["externalPetApp"] = descriptor.url.path
                checks["externalPetBundle"] = descriptor.bundleIdentifier
                checks["externalPetPatch"] = descriptor.patchVersion ?? "upstream"
                checks["externalPet"] = "validated; not started"
                if let catalog = descriptor.catalog {
                    checks["petActions"] = catalog.actionCount
                    checks["petActionGroups"] = ["idle": catalog.idleCount, "interaction": catalog.interactionCount,
                                                "work": catalog.workCount, "special": catalog.specialCount, "movement": catalog.movementCount]
                    checks["pet"] = "full animated pet; task following requires enhanced helper in launch/watch"
                }
            } catch { checks["externalPet"] = error.localizedDescription; ok = false }
        }
        checks["posterReady"] = FileManager.default.fileExists(atPath: runtime.posterURL.path)
        checks["ok"] = ok
        if let data = try? JSONSerialization.data(withJSONObject: checks, options: [.prettyPrinted, .sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
        return ok
    }
}
