import AppKit
import CharacterCore
import CharacterMemory
import CharacterUI
import ApplicationServices
import DragonCore
import SwiftUI

private final class PetMenuAction: NSObject {
    let instanceID: String
    let size: Int?
    let cloneSourceID: String?

    init(instanceID: String, size: Int? = nil, cloneSourceID: String? = nil) {
        self.instanceID = instanceID
        self.size = size
        self.cloneSourceID = cloneSourceID
    }
}

@MainActor
final class Coordinator: NSObject, NSMenuDelegate {
    enum Mode: Equatable { case launch, watch, previewAnimation, previewPet, previewCharacterWindow, controlTest }
    private let runtime: Runtime
    private let mode: Mode
    private let speechTurnTimeout: TimeInterval
    private let characterChatProvider: CharacterChatProvider
    private let diagnostics: Diagnostics
    private var session = LaunchSession()
    private var target: NSRunningApplication?
    private var pet: PetController
    private var multiPet: PetInstanceRuntime?
    private var speechRuntime: SpeechRuntimeSupervisor?
    private var speechChatInProgress = false
    private var speechReplyTask: Task<Void, Never>?
    private var speechTurnTimer: Timer?
    private var speechTurnCancellation: (() -> Void)?
    private var speechCueInProgress = false
    private var pendingSpeechCue: String?
    private var speechCueRetryTimer: Timer?
    private var speechCueTimer: Timer?
    private var speechMenuOpen = false
    private var speechPrewarmAfterCue = false
    private var speechWarmupInProgress = false
    private var speechWarmupCompletion: (() -> Void)?
    private var speechWarmupPetShow: (() -> Void)?
    private var speechWarmupTimer: Timer?
    private var speechWarmupReferenceURL: URL?
    private var speechWarmupHasScopedAccess = false
    private var speechWarmupStartedAt: TimeInterval?
    private var speechWarmupAfterExitScheduled = false
    private var speechWarmupAfterExitCompletions: [() -> Void] = []
    private var speechSettingsController: SpeechSettingsWindow?
    private var companionWorkspaceWindow: CompanionWorkspaceWindow?
    private var petManagerWindow: PetManagerWindow?
    private var movie: BootPlayer?
    private var movieID: UUID?
    private var launchRequestID: UUID?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var poll: Timer?
    private var taskLeaseTimer: Timer?
    private var pendingSince = 0.0
    private var lastFrame: NSRect?
    private var stableFrames = 0
    private var windowSizeRequested = false
    private var lastWindowSizeAttempt = 0.0
    private var reportedWindowReady = false
    private var requestedStartupFrame: NSRect?
    private var firstCloneInProgress = false
    private var stopping = false
    private var statusItem: NSStatusItem?
    private var menu: NSMenu?
    private var lastMultiPetSnapshot: Data?
    private(set) var paused = false
    var isSpeechRuntimeRunning: Bool { speechRuntime?.isRunning == true }

    init(runtime: Runtime, mode: Mode, speechTurnTimeout: TimeInterval = 180,
         characterChatProvider: CharacterChatProvider? = nil) {
        self.runtime = runtime; self.mode = mode
        self.characterChatProvider = characterChatProvider ?? .live
        self.speechTurnTimeout = max(0.01, speechTurnTimeout)
        diagnostics = Diagnostics(root: runtime.state); pet = PetController(runtime: runtime)
        multiPet = PetInstanceRuntime.hasValidRegistry(runtime: runtime)
            ? PetInstanceRuntime(runtime: runtime) : nil
        let repository = ProcessInfo.processInfo.environment["DRAGON_DEV_ROOT"].map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL
        } ?? runtime.resources.deletingLastPathComponent()
        let speechScript = repository.appendingPathComponent("apps/speech-runtime/stdio_service.py")
        let speechPython = repository.appendingPathComponent(".local/voice-runtime/venv/bin/python")
        if FileManager.default.fileExists(atPath: speechScript.path),
           FileManager.default.isExecutableFile(atPath: speechPython.path) {
            speechRuntime = SpeechRuntimeSupervisor(
                executable: speechPython,
                arguments: [speechScript.path]
            )
        }
        super.init()
        pet.taskFollowingAllowed = mode == .watch || mode == .launch
        multiPet?.taskFollowingAllowed = mode == .watch || mode == .launch
        pet.onError = { [weak self] message in self?.diagnostics.record("pet.error \(message)") }
        pet.onChanged = { [weak self] in
            self?.rebuildMenu()
            self?.companionWorkspaceWindow?.refreshPetControls()
        }
        pet.onHide = { [weak self] in _ = self?.handle(.init(.hide)) }
        multiPet?.onChanged = { [weak self] in
            guard let self, let multiPet = self.multiPet else { return }
            var snapshot = (try? JSONEncoder().encode(multiPet.instances)) ?? Data()
            snapshot.append(contentsOf: "|\(multiPet.state)|\(multiPet.isLoadingStatus)|\(multiPet.lastError ?? "")".utf8)
            guard snapshot != self.lastMultiPetSnapshot else { return }
            self.lastMultiPetSnapshot = snapshot
            self.diagnostics.record("multi-pet.changed state=\(multiPet.state)")
            self.rebuildMenu()
            self.companionWorkspaceWindow?.refreshPetControls()
        }
        multiPet?.onDiagnostic = { [weak self] event in self?.diagnostics.record(event) }
    }

    func start() {
        diagnostics.record("controller.start mode=\(mode)")
        guard mode != .controlTest else { return }
        if mode == .previewCharacterWindow {
            openWorkspace(.character)
            return
        }
        createMenu()
        // Keep normal startup clear for the boot animation and Codex handoff.
        // The management workspace opens on an explicit menu-bar click.
        if mode == .previewPet {
            prewarmInteractiveSpeech { [weak self] in
                guard let self, !self.stopping, !self.paused,
                      !self.session.hidden, !self.session.dismissed,
                      self.speechWarmupPetShow == nil else { return }
                self.showPetRuntime(near: nil)
            }
            return
        }
        if mode == .launch || mode == .watch {
            prewarmInteractiveSpeech { [weak self] in
                guard let self, !self.stopping, !self.paused,
                      !self.session.hidden, !self.session.dismissed,
                      self.speechWarmupPetShow == nil else { return }
                self.multiPet?.start()
            }
        } else if multiPet?.isConfigured == true, mode != .previewAnimation { multiPet?.start() }
        if mode == .previewAnimation {
            play(frame: nil); return
        }
        refreshTaskLease()
        taskLeaseTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshTaskLease() }
        }
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers.append(center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            Task { @MainActor in self?.observed(app, alreadyRunning: false) }
        })
        workspaceObservers.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            Task { @MainActor in self?.terminated(app) }
        })
        if let existing = runningCodex() {
            observed(existing, alreadyRunning: true)
        } else if mode == .launch { launchCodex() }
    }

    private func refreshTaskLease(disabled: Bool = false) {
        let enabled = !disabled && !paused && runtime.configuration.taskFollowingEnabled && runningCodex() != nil
        let snapshot: [String: Any] = ["schemaVersion": 1, "enabled": enabled,
                                      "observedAt": Date().timeIntervalSince1970]
        guard let data = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
        let url = runtime.state.appendingPathComponent("codex-task-lease.json")
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func runningCodex() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: runtime.configuration.codexBundleIdentifier).first { !$0.isTerminated }
    }
    private func observed(_ app: NSRunningApplication, alreadyRunning: Bool) {
        guard !paused, !app.isTerminated, app.bundleIdentifier == runtime.configuration.codexBundleIdentifier,
              session.pid != app.processIdentifier else { return }
        if let previous = session.pid {
            _ = session.terminate(pid: previous)
            movie?.finish(.targetExited, immediate: true); movie = nil
            dismissPetRuntime()
        }
        guard session.begin(pid: app.processIdentifier, alreadyRunning: alreadyRunning) else { return }
        target = app
        diagnostics.record("codex.detected pid=\(app.processIdentifier) existing=\(alreadyRunning)")
        if alreadyRunning && movie == nil {
            showPetRuntime(near: WindowGeometry.codexWindow(pid: app.processIdentifier)); return
        }
        // Activating only at movie completion can defer foreground initialization until then.
        let activated = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        diagnostics.record("codex.foreground-requested accepted=\(activated)")
        if session.phase != .playing && session.phase != .waitingWindow {
            // The user skipped (or media failed) before the asynchronous launch callback.
            if !session.hidden && !session.dismissed {
                showPetRuntime(near: WindowGeometry.codexWindow(pid: app.processIdentifier))
            }
            return
        }
        pendingSince = ProcessInfo.processInfo.systemUptime; lastFrame = nil; stableFrames = 0
        windowSizeRequested = false; lastWindowSizeAttempt = 0
        reportedWindowReady = false; requestedStartupFrame = nil
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollWindow() }
        }
        if movie == nil {
            session.startAnimation(pid: app.processIdentifier)
            play(frame: nil)
        }
        pollWindow()
    }
    private func pollWindow() {
        guard !paused, let target, !target.isTerminated else { poll?.invalidate(); poll = nil; return }
        if let frame = WindowGeometry.codexWindow(pid: target.processIdentifier) {
            stableFrames = frame == lastFrame ? stableFrames + 1 : 1; lastFrame = frame
            if stableFrames >= 2 {
                if !windowSizeRequested, requestStartupWindowSize(for: frame) {
                    lastFrame = nil; stableFrames = 0
                    return // Read the actual post-resize window before handoff.
                }
                movie?.match(frame: frame)
                if target.isFinishedLaunching && !reportedWindowReady {
                    reportedWindowReady = true
                    let matched = requestedStartupFrame.map { StartupPresentation.framesMatch(frame, $0) } ?? false
                    let elapsed = ProcessInfo.processInfo.systemUptime - pendingSince
                    diagnostics.record("codex.window-visible elapsed=\(String(format: "%.2f", elapsed)) sizeMatched=\(matched); content-readiness=unknown")
                }
            }
        } else {
            stableFrames = 0; lastFrame = nil
        }
        if !reportedWindowReady && ProcessInfo.processInfo.systemUptime - pendingSince > runtime.configuration.windowWaitTimeout {
            poll?.invalidate(); poll = nil
            diagnostics.record("animation.timed-out no-visible-window")
            movie?.finish(.timedOut)
        }
    }

    @discardableResult
    private func requestStartupWindowSize(for frame: NSRect, force: Bool = false) -> Bool {
        guard let target, !target.isTerminated else { return false }
        let now = ProcessInfo.processInfo.systemUptime
        // The first stable CG frame can arrive before Chromium exposes its AX window.
        // Retry at a bounded rate instead of permanently giving up after that race.
        guard force || now - lastWindowSizeAttempt >= 0.8 else { return false }
        lastWindowSizeAttempt = now

        let screen = WindowGeometry.screen(for: frame)
        let visible = screen?.visibleFrame ?? frame
        let desired = requestedStartupFrame ?? StartupPresentation.videoFrame(
            near: frame, visible: visible, maximumWidth: runtime.configuration.playerMaxWidth)
        requestedStartupFrame = desired
        let result = StartupWindowSizing.request(pid: target.processIdentifier, matching: frame, desired: desired,
                                                  visible: visible,
                                                  primaryTop: Double(NSScreen.screens.first?.frame.maxY ?? 0))
        diagnostics.record("codex.window-size result=\(result.rawValue) force=\(force)")
        if result == .requested {
            windowSizeRequested = true
            return true
        }
        return false
    }

    private func finalizeStartupWindowSize() {
        guard mode != .previewAnimation, let target, !target.isTerminated,
              let frame = WindowGeometry.codexWindow(pid: target.processIdentifier) else { return }
        // A final pass covers the common case where AX becomes available only after
        // the first visible window frame, and keeps the client at the movie's frame
        // when the client adjusted its own window while loading.
        _ = requestStartupWindowSize(for: frame, force: true)
    }

    private func play(frame: NSRect?) {
        let id = UUID(); movieID = id
        movie = BootPlayer(config: runtime.configuration, diagnostics: diagnostics,
                           preservesTargetActivation: mode != .previewAnimation) { [weak self] outcome in
            guard let self, self.movieID == id else { return }
            self.movieID = nil; self.movie = nil
            self.poll?.invalidate(); self.poll = nil
            self.finalizeStartupWindowSize()
            if self.mode == .previewAnimation {
                // Preview is isolated: no Codex launch, no external pet, no theme.
                self.diagnostics.record("preview.finished \(outcome.rawValue)")
                return
            }
            let pid = self.session.pid
            let showPet = self.session.finishAnimation(pid: pid)
            if !self.paused, let app = self.target, !app.isTerminated, showPet {
                self.showPetRuntime(near: WindowGeometry.codexWindow(pid: app.processIdentifier))
            }
        }
        movie?.start(url: runtime.videoURL, matching: frame)
    }
    private func terminated(_ app: NSRunningApplication) {
        guard session.terminate(pid: app.processIdentifier) else { return }
        target = nil; poll?.invalidate(); poll = nil
        movie?.finish(.targetExited, immediate: true); movie = nil
        dismissPetRuntime(); diagnostics.record("codex.exited")
    }
    private func launchCodex() {
        if let existing = runningCodex() {
            observed(existing, alreadyRunning: true)
            _ = existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            return
        }
        guard launchRequestID == nil else { return }
        do {
            let url = try runtime.codexURL()
            let requestID = UUID(); launchRequestID = requestID
            if !paused && session.prepareLaunch() {
                stableFrames = 0; lastFrame = nil
                // Start covering immediately, while NSWorkspace launches Codex in parallel.
                play(frame: nil)
            }
            let options = NSWorkspace.OpenConfiguration(); options.activates = true; options.createsNewApplicationInstance = false
            options.arguments = runtime.startupLaunchArguments(at: url)
            diagnostics.record("codex.launch-requested occlusionSwitch=\(!options.arguments.isEmpty)")
            NSWorkspace.shared.openApplication(at: url, configuration: options) { [weak self] app, error in
                Task { @MainActor in
                    guard let self, self.launchRequestID == requestID else { return }
                    self.launchRequestID = nil
                    if let app { self.observed(app, alreadyRunning: false) }
                    else if self.target == nil {
                        self.session.cancelPendingLaunch()
                        self.movie?.finish(.targetExited, immediate: true)
                        self.diagnostics.record("codex.launch-failed")
                        if !self.paused { self.showError(error?.localizedDescription ?? "Codex 启动失败") }
                    }
                }
            }
            diagnostics.record("codex.openApplication-submitted")
        } catch { showError(error.localizedDescription) }
    }
    private func showError(_ text: String) {
        let alert = NSAlert(); alert.messageText = AppCopy.name; alert.informativeText = text
        alert.addButton(withTitle: "好"); alert.runModal()
    }

    private func showPetRuntime(near frame: NSRect?, startAllManaged: Bool = false) {
        if speechWarmupInProgress {
            speechWarmupPetShow = { [weak self] in
                guard let self, !self.stopping, !self.paused,
                      !self.session.hidden, !self.session.dismissed else { return }
                self.showPetRuntime(near: frame, startAllManaged: startAllManaged)
            }
            return
        }
        if let multiPet {
            if startAllManaged { multiPet.startEnabledInstances() }
            else { multiPet.restoreAutoStartedInstances() }
        } else {
            pet.show(near: frame)
        }
    }

    private func hidePetRuntime() {
        speechWarmupPetShow = nil
        if let multiPet { multiPet.stopAllInstances() } else { pet.hide() }
    }

    private func dismissPetRuntime() {
        speechWarmupPetShow = nil
        if let multiPet { multiPet.stop() } else { pet.dismiss(preserveIndependentExternal: true) }
    }

    func handle(_ request: ControlRequest) -> CompanionStatus {
        switch request.command {
        case .status: break
        case .hide: session.hidePet(); hidePetRuntime()
        case .dismiss: session.dismissPet(); dismissPetRuntime()
        case .show:
            session.showPet()
            if !paused && (mode == .previewPet || (session.pid != nil && session.phase == .accompanying)) {
                showPetRuntime(near: lastFrame, startAllManaged: true)
            }
        case .pause:
            paused = true; refreshTaskLease(disabled: true); poll?.invalidate(); poll = nil
            if let pid = session.pid { _ = session.finishAnimation(pid: pid) }
            movie?.finish(.skipped, immediate: true); movie = nil; hidePetRuntime()
        case .resume:
            guard paused else { return snapshot("已经在联动") }
            paused = false
            refreshTaskLease()
            if mode == .previewPet { showPetRuntime(near: nil) }
            if mode == .watch || mode == .launch {
                if let app = runningCodex() {
                    // A resume does not replay the startup movie.
                    if session.pid != app.processIdentifier { observed(app, alreadyRunning: true) }
                    else if !session.dismissed && !session.hidden { showPetRuntime(near: WindowGeometry.codexWindow(pid: app.processIdentifier)) }
                }
            }
        case .quit:
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
        case .speak:
            speakInteractionCue(request.text)
        }
        rebuildMenu()
        return snapshot("\(request.command.rawValue) 已处理")
    }

    private func speakInteractionCue(_ text: String?) {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty, text.utf8.count <= 512,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !stopping, !paused else {
            diagnostics.record("speech.cue.rejected")
            return
        }
        guard let speechRuntime else {
            diagnostics.record("speech.cue.rejected reason=runtime-unavailable")
            return
        }
        let settings: SpeechSettings
        do { settings = try SpeechSettingsStore(stateDirectory: runtime.state).load() }
        catch { diagnostics.record("speech.cue.rejected reason=settings-unavailable"); return }
        guard settings.speakInteractiveBubbles,
              let bookmark = settings.referenceAudioBookmark,
              !settings.referenceAudioPath.isEmpty,
              !settings.referenceTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            diagnostics.record("speech.cue.rejected reason=disabled-or-reference-unavailable")
            return
        }
        guard !speechChatInProgress, !speechCueInProgress, !speechWarmupInProgress,
              !speechMenuOpen, !speechWarmupAfterExitScheduled, !speechRuntime.isStopping else {
            pendingSpeechCue = text
            diagnostics.record("speech.cue.deferred latest-wins")
            return
        }
        guard NSApp.modalWindow == nil else {
            pendingSpeechCue = text
            scheduleSpeechCueRetry()
            diagnostics.record("speech.cue.deferred latest-wins")
            return
        }
        pendingSpeechCue = nil
        speechCueRetryTimer?.invalidate()
        speechCueRetryTimer = nil
        let repository = ProcessInfo.processInfo.environment["DRAGON_DEV_ROOT"].map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL
        } ?? runtime.resources.deletingLastPathComponent()
        let modelRoot = repository.appendingPathComponent(".local/voice-runtime/models")
        let ttsModel = modelRoot.appendingPathComponent("Qwen3-TTS-12Hz-0.6B-Base-8bit")
        guard FileManager.default.fileExists(atPath: ttsModel.path) else {
            diagnostics.record("speech.cue.rejected reason=models-unavailable"); return
        }
        var stale = false
        guard let referenceURL = resolveReferenceBookmark(bookmark, stale: &stale),
              !stale, referenceURL.path == settings.referenceAudioPath else {
            diagnostics.record("speech.cue.rejected reason=reference-unavailable"); return
        }
        let hasScopedAccess = referenceURL.startAccessingSecurityScopedResource()
        var info = stat()
        guard lstat(referenceURL.path, &info) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), access(referenceURL.path, R_OK) == 0 else {
            if hasScopedAccess { referenceURL.stopAccessingSecurityScopedResource() }
            diagnostics.record("speech.cue.rejected reason=reference-unreadable"); return
        }
        let arguments = ["--tts-only", "--tts-model", ttsModel.path,
                         "--reference-audio", referenceURL.path,
                         "--reference-text", settings.referenceTranscript, "--allow-speaker-output"]
        speechCueInProgress = true
        let wasRunning = speechRuntime.isRunning
        var submitOnReady = !wasRunning || !speechRuntime.isReady
        var restartingForCue = false
        var finished = false
        var failureReason: String?
        func finish(_ reason: String) {
            guard !finished else { return }
            finished = true
            speechCueTimer?.invalidate(); speechCueTimer = nil
            speechCueInProgress = false
            // Completed handlers capture the cue, reference and coordinator. Drop
            // them before draining another cue or handing off to a new process.
            speechRuntime.onEvent = nil
            speechRuntime.onExit = { [weak self] _ in self?.releaseSpeechWarmupReference() }
            if hasScopedAccess { referenceURL.stopAccessingSecurityScopedResource() }
            diagnostics.record("speech.cue.finished reason=\(reason)")
            if speechPrewarmAfterCue {
                speechPrewarmAfterCue = false
                let settings = try? SpeechSettingsStore(stateDirectory: runtime.state).load()
                if settings?.speakInteractiveBubbles == true {
                    prewarmInteractiveSpeech(completion: {})
                } else {
                    stopInteractiveSpeechRuntimeIfDisabled()
                }
            } else {
                stopInteractiveSpeechRuntimeIfDisabled()
            }
            drainPendingSpeechCue()
        }
        func failCue(_ reason: String) {
            guard !finished, failureReason == nil else { return }
            failureReason = reason
            speechCueTimer?.invalidate(); speechCueTimer = nil
            speechRuntime.shutdownGracefully(timeout: 0.2) { finish(reason) }
        }
        let watchdog = Timer(timeInterval: speechTurnTimeout, repeats: false) { _ in
            Task { @MainActor in
                guard !finished, !self.stopping else { return }
                self.diagnostics.record("speech.cue.timed-out")
                failCue("timeout")
            }
        }
        speechCueTimer = watchdog
        RunLoop.main.add(watchdog, forMode: .common)
        speechRuntime.onEvent = { [weak speechRuntime] event in
            guard !finished, failureReason == nil, !self.stopping else { return }
            if event.type == "ready" {
                // A process can still be loading after the startup wait timed out.
                // Submit once on ready, including after a configuration restart.
                if submitOnReady {
                    submitOnReady = false
                    do { try speechRuntime?.sendResponse(text: text, speak: true) }
                    catch { failCue("submit-failed") }
                }
                return
            }
            guard event.type == "session" else {
                if event.type == "error" { failCue("runtime-error") }
                return
            }
            if event.state == "error" { failCue("synthesis-failed") }
            else if event.state == "idle" { finish("success") }
        }
        speechRuntime.onExit = { status in
            self.releaseSpeechWarmupReference()
            if let failureReason { finish(failureReason); return }
            if restartingForCue && !self.stopping {
                restartingForCue = false
                do { try speechRuntime.start(appendingArguments: arguments) }
                catch { finish("restart-failed") }
                return
            }
            finish(status == 0 ? "runtime-exited" : "runtime-failed")
        }
        do {
            if wasRunning {
                if !speechRuntime.isRunning(withAdditionalArguments: arguments) {
                    restartingForCue = true
                    submitOnReady = true
                    speechRuntime.shutdownGracefully()
                    return
                }
                if !submitOnReady { try speechRuntime.sendResponse(text: text, speak: true) }
            } else {
                try speechRuntime.start(appendingArguments: arguments)
            }
        } catch {
            if speechRuntime.isRunning { failCue("submit-failed") }
            else { finish("start-failed") }
        }
    }

    private func scheduleSpeechCueRetry() {
        guard speechCueRetryTimer == nil, !stopping else { return }
        let timer = Timer(timeInterval: 0.5, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.speechCueRetryTimer = nil
                self.drainPendingSpeechCue()
            }
        }
        speechCueRetryTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func prewarmInteractiveSpeech(timeout: TimeInterval = 12, completion: @escaping () -> Void) {
        // Process.isRunning can become false before its termination handler runs.
        // Keep requests joined until that handler has released the old resources.
        if !stopping, speechWarmupAfterExitScheduled {
            speechWarmupAfterExitCompletions.append(completion)
            return
        }
        guard !stopping, !speechWarmupInProgress, !speechChatInProgress, !speechCueInProgress,
              let speechRuntime,
              let settings = try? SpeechSettingsStore(stateDirectory: runtime.state).load(),
              settings.speakInteractiveBubbles,
              let bookmark = settings.referenceAudioBookmark,
              !settings.referenceAudioPath.isEmpty,
              !settings.referenceTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion()
            return
        }
        let repository = ProcessInfo.processInfo.environment["DRAGON_DEV_ROOT"].map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL
        } ?? runtime.resources.deletingLastPathComponent()
        let ttsModel = repository.appendingPathComponent(".local/voice-runtime/models/Qwen3-TTS-12Hz-0.6B-Base-8bit")
        guard FileManager.default.fileExists(atPath: ttsModel.path) else {
            diagnostics.record("speech.runtime.prewarm-skipped reason=models-unavailable")
            completion()
            return
        }
        var stale = false
        guard let referenceURL = resolveReferenceBookmark(bookmark, stale: &stale),
              !stale, referenceURL.path == settings.referenceAudioPath else {
            diagnostics.record("speech.runtime.prewarm-skipped reason=reference-unavailable")
            completion()
            return
        }
        let hasScopedAccess = referenceURL.startAccessingSecurityScopedResource()
        var info = stat()
        guard lstat(referenceURL.path, &info) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), access(referenceURL.path, R_OK) == 0 else {
            if hasScopedAccess { referenceURL.stopAccessingSecurityScopedResource() }
            diagnostics.record("speech.runtime.prewarm-skipped reason=reference-unreadable")
            completion()
            return
        }
        let arguments = ["--tts-only", "--tts-model", ttsModel.path,
                         "--reference-audio", referenceURL.path,
                         "--reference-text", settings.referenceTranscript, "--allow-speaker-output"]
        var shouldStartProcess = true
        if speechRuntime.isRunning {
            if speechRuntime.isStopping {
                if hasScopedAccess { referenceURL.stopAccessingSecurityScopedResource() }
                restartSpeechWarmupAfterStopping(speechRuntime, timeout: timeout, completion: completion)
                return
            }
            guard speechRuntime.isRunning(withAdditionalArguments: arguments) else {
                if hasScopedAccess { referenceURL.stopAccessingSecurityScopedResource() }
                if speechRuntime.isTTSOnly {
                    restartSpeechWarmupAfterStopping(speechRuntime, timeout: timeout, completion: completion)
                    return
                }
                completion()
                return
            }
            if speechRuntime.isReady {
                if hasScopedAccess { referenceURL.stopAccessingSecurityScopedResource() }
                completion()
                return
            }
            shouldStartProcess = false
        }

        speechWarmupInProgress = true
        speechWarmupCompletion = completion
        if speechWarmupHasScopedAccess { speechWarmupReferenceURL?.stopAccessingSecurityScopedResource() }
        speechWarmupReferenceURL = referenceURL
        speechWarmupHasScopedAccess = hasScopedAccess
        speechWarmupStartedAt = ProcessInfo.processInfo.systemUptime
        diagnostics.record("speech.runtime.prewarming")
        speechRuntime.onEvent = { [weak self] event in
            guard let self else { return }
            if event.type == "ready" {
                self.finishSpeechWarmup(ready: true)
            } else if event.type == "error" {
                self.finishSpeechWarmup(ready: false)
            }
        }
        speechRuntime.onExit = { [weak self] _ in
            self?.releaseSpeechWarmupReference()
            self?.finishSpeechWarmup(ready: false)
        }
        let timer = Timer(timeInterval: max(0.01, timeout), repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.speechWarmupInProgress else { return }
                self.diagnostics.record("speech.runtime.prewarm-timeout")
                self.finishSpeechWarmup(ready: false)
            }
        }
        speechWarmupTimer = timer
        RunLoop.main.add(timer, forMode: .common)
        do {
            if shouldStartProcess { try speechRuntime.start(appendingArguments: arguments) }
        }
        catch {
            diagnostics.record("speech.runtime.prewarm-failed")
            releaseSpeechWarmupReference()
            finishSpeechWarmup(ready: false)
        }
    }

    private func restartSpeechWarmupAfterStopping(_ speechRuntime: SpeechRuntimeSupervisor,
                                                  timeout: TimeInterval,
                                                  completion: @escaping () -> Void) {
        speechWarmupAfterExitCompletions.append(completion)
        guard !speechWarmupAfterExitScheduled else { return }
        speechWarmupAfterExitScheduled = true
        let resume: @MainActor () -> Void = { [weak self] in
            guard let self else { return }
            self.speechWarmupAfterExitScheduled = false
            let completions = self.speechWarmupAfterExitCompletions
            self.speechWarmupAfterExitCompletions.removeAll()
            guard !self.stopping else { return }
            self.prewarmInteractiveSpeech(timeout: timeout) {
                completions.forEach { $0() }
            }
        }
        if speechRuntime.isReady { speechRuntime.shutdownGracefully(completion: resume) }
        else { speechRuntime.terminateImmediately(completion: resume) }
    }

    private func finishSpeechWarmup(ready: Bool) {
        guard speechWarmupInProgress else { return }
        speechWarmupInProgress = false
        speechWarmupTimer?.invalidate(); speechWarmupTimer = nil
        let elapsed = speechWarmupStartedAt.map {
            Int((ProcessInfo.processInfo.systemUptime - $0) * 1_000)
        }
        speechWarmupStartedAt = nil
        diagnostics.record("speech.runtime.prewarm-finished ready=\(ready) elapsed-ms=\(elapsed ?? 0)")
        let completion = speechWarmupCompletion
        speechWarmupCompletion = nil
        completion?()
        let showPet = speechWarmupPetShow
        speechWarmupPetShow = nil
        showPet?()
        drainPendingSpeechCue()
    }

    private func releaseSpeechWarmupReference() {
        if speechWarmupHasScopedAccess { speechWarmupReferenceURL?.stopAccessingSecurityScopedResource() }
        speechWarmupReferenceURL = nil
        speechWarmupHasScopedAccess = false
    }

    func interactiveSpeechSettingsDidChange(_ settings: SpeechSettings, completion: @escaping () -> Void = {}) {
        guard settings.speakInteractiveBubbles else {
            speechPrewarmAfterCue = false
            pendingSpeechCue = nil
            speechCueRetryTimer?.invalidate()
            speechCueRetryTimer = nil
            if speechWarmupInProgress { finishSpeechWarmup(ready: false) }
            stopInteractiveSpeechRuntimeIfDisabled()
            completion()
            return
        }
        if speechCueInProgress {
            speechPrewarmAfterCue = true
            completion()
            return
        }
        prewarmInteractiveSpeech(completion: completion)
    }

    private func stopInteractiveSpeechRuntimeIfDisabled() {
        guard !stopping, !speechCueInProgress, !speechChatInProgress,
              let speechRuntime, speechRuntime.isTTSOnly else { return }
        let enabled = (try? SpeechSettingsStore(stateDirectory: runtime.state).load().speakInteractiveBubbles) ?? false
        guard !enabled else { return }
        diagnostics.record("speech.runtime.prewarm-releasing reason=interactive-disabled")
        let stopped: @MainActor () -> Void = { [weak self] in
            self?.releaseSpeechWarmupReference()
        }
        if !speechRuntime.isReady { speechRuntime.terminateImmediately(completion: stopped) }
        else { speechRuntime.shutdownGracefully(completion: stopped) }
    }

    private func drainPendingSpeechCue() {
        guard let text = pendingSpeechCue, !stopping else { return }
        guard !speechChatInProgress, !speechCueInProgress, !speechWarmupInProgress,
              !speechWarmupAfterExitScheduled, !speechMenuOpen else {
            return
        }
        guard NSApp.modalWindow == nil else {
            scheduleSpeechCueRetry()
            return
        }
        pendingSpeechCue = nil
        speakInteractionCue(text)
    }

    func menuWillOpen(_ menu: NSMenu) {
        speechMenuOpen = true
    }

    func menuDidClose(_ menu: NSMenu) {
        speechMenuOpen = false
        drainPendingSpeechCue()
    }
    func snapshot(_ message: String = AppCopy.runningMessage) -> CompanionStatus {
        CompanionStatus(message: message, phase: session.phase.rawValue, codexPID: session.pid, paused: paused,
                        petVisible: multiPet?.isVisible ?? pet.isVisible, backend: multiPet == nil ? runtime.configuration.petBackend : "external-multi",
                        posterReady: FileManager.default.fileExists(atPath: runtime.posterURL.path),
                        petState: multiPet?.state ?? pet.state, petError: multiPet?.lastError ?? pet.lastError)
    }
    func stop() {
        stopping = true
        speechReplyTask?.cancel(); speechReplyTask = nil
        speechTurnTimer?.invalidate(); speechTurnTimer = nil
        speechCueTimer?.invalidate(); speechCueTimer = nil
        speechWarmupTimer?.invalidate(); speechWarmupTimer = nil
        speechWarmupCompletion = nil
        speechWarmupPetShow = nil
        speechWarmupInProgress = false
        speechWarmupAfterExitCompletions.removeAll()
        speechCueRetryTimer?.invalidate(); speechCueRetryTimer = nil
        pendingSpeechCue = nil
        speechPrewarmAfterCue = false
        speechMenuOpen = false
        speechRuntime?.shutdownGracefully()
        firstCloneInProgress = false
        taskLeaseTimer?.invalidate(); taskLeaseTimer = nil
        refreshTaskLease(disabled: true)
        paused = true
        launchRequestID = nil; session.cancelPendingLaunch()
        poll?.invalidate(); poll = nil; movie?.finish(.targetExited, immediate: true); movie = nil
        dismissPetRuntime()
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll(); diagnostics.record("controller.stop")
    }
    func finishStopping(completion: @escaping @MainActor () -> Void) {
        var petStopped = false
        var speechStopped = speechRuntime?.isRunning != true
        let finishIfStopped = {
            guard petStopped, speechStopped else { return }
            self.releaseSpeechWarmupReference()
            completion()
        }
        if let multiPet {
            multiPet.finishStopping {
                petStopped = true
                finishIfStopped()
            }
        } else {
            pet.finishWindowCommands {
                petStopped = true
                finishIfStopped()
            }
        }
        speechRuntime?.shutdownGracefully {
            speechStopped = true
            finishIfStopped()
        }
    }

    func startSpeechRuntime() throws {
        try speechRuntime?.start()
        guard speechRuntime != nil else {
            throw SpeechRuntimeSupervisor.SupervisorError.executableUnavailable
        }
    }

    func stopSpeechRuntimeImmediately() { speechRuntime?.terminateImmediately() }

    func sendSpeechChat(platform: String, messageID: String, text: String) throws {
        guard let speechRuntime else { throw SpeechRuntimeSupervisor.SupervisorError.executableUnavailable }
        try speechRuntime.sendChat(platform: platform, messageID: messageID, text: text)
    }

    private func createMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let icon = makeStatusItemImage()
        statusItem?.button?.image = icon
        statusItem?.button?.toolTip = "\(AppCopy.name) · \(AppCopy.tagline)"
        statusItem?.button?.target = self
        statusItem?.button?.action = #selector(statusItemClicked(_:))
        statusItem?.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        rebuildMenu()
    }

    private func makeStatusItemImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18))
        image.lockFocus()
        NSColor.black.set()

        let window = NSBezierPath(roundedRect: NSRect(x: 2.5, y: 2.5, width: 13, height: 10),
                                  xRadius: 2, yRadius: 2)
        window.lineWidth = 1.4
        window.stroke()

        let divider = NSBezierPath()
        divider.move(to: NSPoint(x: 3.5, y: 9.5))
        divider.line(to: NSPoint(x: 14.5, y: 9.5))
        divider.lineWidth = 1.2
        divider.stroke()

        let star = NSBezierPath()
        star.move(to: NSPoint(x: 10, y: 16))
        star.line(to: NSPoint(x: 11.2, y: 12.2))
        star.line(to: NSPoint(x: 15, y: 11))
        star.line(to: NSPoint(x: 11.2, y: 9.8))
        star.line(to: NSPoint(x: 10, y: 6))
        star.line(to: NSPoint(x: 8.8, y: 9.8))
        star.line(to: NSPoint(x: 5, y: 11))
        star.line(to: NSPoint(x: 8.8, y: 12.2))
        star.close()
        star.fill()

        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    private func rebuildMenu() {
        guard statusItem != nil else { return }
        let menu = NSMenu(title: AppCopy.name)
        let exit = NSMenuItem(title: AppCopy.quitTitle, action: #selector(quit), keyEquivalent: "")
        exit.target = self
        menu.addItem(exit)
        self.menu = menu
    }

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else {
            diagnostics.record("workspace.status-item-click event=unavailable route=pets")
            openWorkspace(.pets)
            return
        }
        if event.type == .rightMouseUp {
            guard let menu else { return }
            NSMenu.popUpContextMenu(menu, with: event, for: sender)
            return
        }
        diagnostics.record("workspace.status-item-click route=pets")
        openWorkspace(.pets)
    }

    private func addInteractiveSpeechMenuItem(to menu: NSMenu) {
        let item: NSMenuItem
        do {
            let settings = try SpeechSettingsStore(stateDirectory: runtime.state).load()
            item = NSMenuItem(
                title: settings.speakInteractiveBubbles ? "互动气泡语音：已开启" : "互动气泡语音：已关闭",
                action: #selector(toggleInteractiveSpeech),
                keyEquivalent: ""
            )
            item.state = settings.speakInteractiveBubbles ? .on : .off
            item.target = self
        } catch {
            item = NSMenuItem(title: "互动气泡语音：设置不可用", action: nil, keyEquivalent: "")
            item.isEnabled = false
            diagnostics.record("speech.menu.rejected reason=settings-unavailable")
        }
        menu.addItem(item)
    }

    func menuNeedsUpdate(_ menu: NSMenu) { rebuildMenu() }

    private func petManagementMenu() -> NSMenu? {
        guard mode != .previewAnimation else { return nil }
        let menu = NSMenu(title: "实例管理")
        let candidate = multiPet ?? PetInstanceRuntime(runtime: runtime)
        let canManage = candidate?.hasValidRegistry == true ||
            (candidate?.registryIsMissing == true && ExternalPetDescriptor.supportsManagedHandoff(runtime))
        if canManage, (try? PetSourceTool(runtime: runtime)) != nil {
            let manage = NSMenuItem(title: "桌宠管理…", action: #selector(openPetManager), keyEquivalent: "")
            manage.target = self
            manage.isEnabled = !paused && !firstCloneInProgress && !stopping
            menu.addItem(manage)
        }
        guard let multiPet, multiPet.hasValidRegistry else { return menu.items.isEmpty ? nil : menu }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        let cloneMenu = NSMenu(title: "创建小分身")
        let allRows = multiPet.instances.sorted { $0.id < $1.id }
        for row in allRows where row.enabled {
            let cloneItem = NSMenuItem(title: "从 \(PetPresentation.name(id: row.id, displayName: row.displayName)) 创建", action: #selector(cloneManagedPet), keyEquivalent: "")
            cloneItem.target = self
            cloneItem.representedObject = PetMenuAction(instanceID: row.id, cloneSourceID: row.id)
            cloneMenu.addItem(cloneItem)
        }
        let cloneEntry = NSMenuItem(title: "创建小分身", action: nil, keyEquivalent: "")
        cloneEntry.submenu = cloneMenu
        cloneEntry.isEnabled = !allRows.isEmpty && allRows.count < 32
        menu.addItem(cloneEntry)
        menu.addItem(.separator())

        let rows = allRows
        if multiPet.isLoadingStatus {
            let loading = NSMenuItem(title: "正在读取桌宠实例状态…", action: nil, keyEquivalent: "")
            loading.isEnabled = false; menu.addItem(loading)
            return menu
        }
        if rows.isEmpty {
            let title = "实例清单为空；为保护数据不会自动初始化"
            let empty = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            empty.isEnabled = false; menu.addItem(empty)
            return menu
        }
        for row in rows {
            let instanceMenu = NSMenu(title: PetPresentation.name(id: row.id, displayName: row.displayName))
            let action = PetMenuAction(instanceID: row.id)
            let running = row.phase == .running || row.phase == .starting
            let lifecycle = NSMenuItem(title: running ? "停止实例" : "启动实例",
                                       action: #selector(toggleManagedPet), keyEquivalent: "")
            lifecycle.target = self; lifecycle.representedObject = action
            lifecycle.isEnabled = !paused && row.enabled && row.phase != .stopping
            instanceMenu.addItem(lifecycle)
            instanceMenu.addItem(.separator())
            let sizeMenu = NSMenu(title: "尺寸")
            for size in [128, 192, 256, 320, 384] {
                let sizeItem = NSMenuItem(title: "\(size) × \(size)", action: #selector(setManagedPetSize), keyEquivalent: "")
                sizeItem.target = self
                sizeItem.representedObject = PetMenuAction(instanceID: row.id, size: size)
                sizeItem.state = row.preferences.size == size ? .on : .off
                sizeMenu.addItem(sizeItem)
            }
            let sizeItem = NSMenuItem(title: "调整尺寸", action: nil, keyEquivalent: "")
            sizeItem.submenu = sizeMenu
            instanceMenu.addItem(sizeItem)
            if row.id != "white-dragon" {
                instanceMenu.addItem(.separator())
                let canDelete = allRows.count > 1
                let delete = NSMenuItem(title: canDelete ? "删除实例…" : "至少保留一个实例",
                                        action: #selector(deleteManagedPet), keyEquivalent: "")
                delete.target = self; delete.representedObject = action
                delete.isEnabled = canDelete && (row.phase == .stopped || row.phase == .failed)
                instanceMenu.addItem(delete)
            }
            let instanceItem = NSMenuItem(title: PetPresentation.menuTitle(row), action: nil, keyEquivalent: "")
            instanceItem.submenu = instanceMenu
            menu.addItem(instanceItem)
        }
        return menu
    }

    @objc private func showPet() { _ = handle(.init(.show)) }
    @objc private func hidePet() { _ = handle(.init(.hide)) }
    @objc private func togglePetAvailability() {
        guard mode != .previewCharacterWindow else { return }
        if let multiPet {
            let active = multiPet.instances.contains { [.starting, .running, .stopping].contains($0.phase) }
            if active {
                hidePetRuntime()
            } else {
                session.showPet()
                showPetRuntime(near: lastFrame, startAllManaged: true)
            }
        } else if pet.isVisible {
            hidePet()
        } else {
            session.showPet()
            showPetRuntime(near: lastFrame)
        }
        rebuildMenu()
        companionWorkspaceWindow?.refreshPetControls()
    }
    @objc private func cloneManagedPet(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? PetMenuAction,
              let sourceID = action.cloneSourceID else { return }
        multiPet?.clone(sourceID: sourceID)
        rebuildMenu()
    }

    @objc private func openPetManager() {
        guard !stopping, !paused, !firstCloneInProgress else { return }
        do {
            if petManagerWindow == nil {
                let window: PetManagerWindow
                if mode == .previewCharacterWindow {
                    window = try PetManagerWindow(runtime: runtime,
                                                  sourceOperation: WorkspacePreviewSources.operation(in: runtime.state))
                    window.addPackages = { packages, completion in
                        completion(.success("离线演示：已接收\(packages.count)只桌宠；未导入素材或启动实例。"))
                    }
                } else {
                    window = try PetManagerWindow(runtime: runtime)
                    window.addPackages = { [weak self] packages, completion in
                        guard let self else { return }
                        self.addLocalPets(packages, completion: completion)
                    }
                }
                petManagerWindow = window
            }
            petManagerWindow?.open(parentWindow: companionWorkspaceWindow?.window)
        } catch { showError(error.localizedDescription) }
    }

    @objc private func openSpeechSettings() {
        openWorkspace(.speech)
    }

    @objc private func openModelManager() {
        openWorkspace(.models)
    }

    @objc private func toggleInteractiveSpeech() {
        guard !stopping else { return }
        let store = SpeechSettingsStore(stateDirectory: runtime.state)
        do {
            let settings = try store.toggleInteractiveBubbleSpeech()
            let enabled = settings.speakInteractiveBubbles
            speechSettingsController?.setInteractiveBubbleSpeechEnabled(enabled)
            diagnostics.record("speech.interactive-bubbles changed enabled=\(enabled)")
            interactiveSpeechSettingsDidChange(settings)
            rebuildMenu()
        } catch {
            diagnostics.record("speech.interactive-bubbles rejected reason=save-failed")
            showError(error.localizedDescription)
        }
    }

    @objc private func openCharacterWindow() {
        openWorkspace(.character)
    }

    @objc private func openCompanionWorkspace() {
        openWorkspace(.pets)
    }

    private func openWorkspace(_ section: WorkspaceSection) {
        diagnostics.record("workspace.open-begin section=\(section.rawValue) stopping=\(stopping) existing=\(companionWorkspaceWindow != nil)")
        guard !stopping else { return }
        do {
            if companionWorkspaceWindow == nil {
                diagnostics.record("workspace.open-create-controllers")
                let offlinePreview = mode == .previewCharacterWindow
                let models = try ModelManagerWindow(store: ModelProviderStore(stateDirectory: runtime.state),
                                                    offlinePreview: offlinePreview)
                diagnostics.record("workspace.open-model-controller-created")
                let speech = try makeSpeechSettingsController()
                diagnostics.record("workspace.open-speech-controller-created")
                let character = try makeCharacterController()
                diagnostics.record("workspace.open-character-controller-created")
                speechSettingsController = speech
                let actions = CompanionWorkspaceWindow.Actions(
                    petStatus: { [weak self] in self?.workspacePetStatus() ?? "桌宠状态暂不可用。" },
                    petServiceConnected: { [weak self] in
                        guard let self else { return false }
                        if let multiPet = self.multiPet {
                            return multiPet.isLoadingStatus || ["running", "visible"].contains(multiPet.state)
                        }
                        return ["running", "running-no-visible-window", "visible", "hidden"].contains(self.pet.state)
                    },
                    petActionTitle: { [weak self] in self?.workspacePetActionTitle() ?? "显示 / 隐藏桌宠" },
                    petIsVisible: { [weak self] in
                        guard let self else { return false }
                        if let multiPet = self.multiPet { return multiPet.instances.contains { $0.phase == .running } }
                        return self.pet.isVisible
                    },
                    togglePet: { [weak self] in self?.togglePetAvailability() },
                    canControlPets: { [weak self] in self?.workspaceCanTogglePets() == true },
                    canTogglePause: { [weak self] in self?.mode != .previewCharacterWindow && self?.stopping == false },
                    petInstances: { [weak self] in self?.workspacePetInstances() ?? [] },
                    toggleInstance: { [weak self] id in self?.workspaceToggleInstance(id) },
                    cloneInstance: { [weak self] id in self?.workspaceCloneInstance(id) },
                    deleteInstance: { [weak self] id in self?.workspaceDeleteInstance(id) },
                    managePets: { [weak self] in self?.openPetManager() },
                    pauseTitle: { [weak self] in self?.paused == true ? "恢复联动" : "暂停联动" },
                    isPaused: { [weak self] in self?.paused == true },
                    togglePause: { [weak self] in self?.togglePause() },
                    openData: { [weak self] in self?.openSettings() },
                    openAccessibility: { [weak self] in self?.openWindowPermissionSettings() },
                    canManagePets: { [weak self] in self?.workspaceCanManagePets() == true },
                    canOpenAccessibility: { !AXIsProcessTrusted() }
                )
                companionWorkspaceWindow = CompanionWorkspaceWindow(models: models, speech: speech,
                                                                      character: character, actions: actions)
                diagnostics.record("workspace.open-window-controller-created hasWindow=\(companionWorkspaceWindow?.window != nil)")
            }
            companionWorkspaceWindow?.open(section)
            diagnostics.record("workspace.open-presented visible=\(companionWorkspaceWindow?.window?.isVisible ?? false) appActive=\(NSApp.isActive) appWindows=\(NSApp.windows.count)")
        } catch {
            diagnostics.record("workspace.open-failed section=\(section.rawValue) error=\(error.localizedDescription)")
            showError(error.localizedDescription)
        }
    }

    private func makeSpeechSettingsController() throws -> SpeechSettingsWindow {
        let offlinePreview = mode == .previewCharacterWindow
        let controller = try SpeechSettingsWindow(store: SpeechSettingsStore(stateDirectory: runtime.state),
                                                  offlinePreview: offlinePreview)
        controller.onSettingsSaved = offlinePreview ? nil : { [weak self] settings in
            self?.interactiveSpeechSettingsDidChange(settings)
        }
        controller.onDemo = offlinePreview ? nil : { [weak self] settings, completion in
            self?.runSpeechDemo(settings, completion: completion)
        }
        controller.onDiagnostic = { [weak self] event in self?.diagnostics.record(event) }
        controller.onCancelVoice = { [weak self] in self?.cancelActiveSpeechTurn() }
        controller.onVoiceChat = offlinePreview ? nil : { [weak self] audioURL, settings, onTranscript, completion in
            self?.runVoiceChat(audioURL, settings: settings, onTranscript: onTranscript, completion: completion)
        }
        return controller
    }

    private func makeCharacterController() throws -> CharacterWorkspaceController {
        let store = try CharacterMemoryStore(stateDirectory: runtime.state, petID: "white-dragon")
        let capabilities = mode == .previewCharacterWindow
            ? CharacterCapabilitySnapshot.offlinePreview
            : CharacterCapabilitySnapshot.make(runtime: runtime, speechRuntimeAvailable: speechRuntime != nil)
        let suggestGoal: ((String, String) async throws -> CharacterGoalDraft)? = mode == .previewCharacterWindow
            ? nil
            : { [weak self] title, details in
                guard let self else { throw ModelProviderError.service("桌边小崽已关闭") }
                let (provider, apiKey) = try self.modelProviderCredentials()
                return try await ModelProviderClient().suggestGoalSteps(settings: provider, apiKey: apiKey,
                                                                          title: title, details: details)
            }
        let chat: (String, [CharacterChatTurn]) async throws -> String = { [weak self] text, history in
            guard let self else { throw ModelProviderError.service("桌边小崽已关闭") }
            return try await self.replyToCharacterChat(text, history: history)
        }
        let navigation = CharacterWorkspaceNavigation()
        let content = CharacterWorkspaceView(store: store, defaultName: "龙妹", capabilities: capabilities,
                                             suggestGoal: suggestGoal, chat: chat, navigation: navigation)
        return CharacterWorkspaceController(content: content, navigation: navigation)
    }

    private func workspacePetInstances() -> [WorkspacePetInstance] {
        let builtin = PetCoverSource.builtin(runtime: runtime)
        let canControl = mode != .previewCharacterWindow && !paused && !stopping && !firstCloneInProgress
        if let multiPet {
            return multiPet.instances.sorted { $0.id < $1.id }.map { row in
                let cover = PetCoverSource(directory: runtime.petLibraryURL.appendingPathComponent("packages")
                    .appendingPathComponent(row.package.id).appendingPathComponent(row.package.version),
                    isPackage: true, fallback: row.package.id == "local.bailong.white-dragon" ? builtin.fallback : nil)
                return WorkspacePetInstance(id: row.id,
                    name: PetPresentation.name(id: row.id, displayName: row.displayName),
                    phase: row.phase, enabled: row.enabled, isClone: PetInstanceDefinition.isCloneID(row.id), error: row.error,
                    canControl: canControl && !multiPet.isLoadingStatus,
                    canClone: canControl && !multiPet.isLoadingStatus && row.enabled && multiPet.instances.count < 32,
                    canDelete: mode != .previewCharacterWindow && !stopping && !multiPet.isLoadingStatus &&
                        multiPet.instances.count > 1 && PetInstanceDefinition.isCloneID(row.id) &&
                        (row.phase == .stopped || row.phase == .failed),
                    cover: cover)
            }
        }
        let phase: PetInstancePhase = pet.lastError != nil ? .failed :
            (["starting", "switching"].contains(pet.state) ? .starting : (pet.isVisible ? .running : .stopped))
        return [WorkspacePetInstance(id: "white-dragon", name: "龙妹", phase: phase, enabled: true,
            isClone: false, error: pet.lastError, canControl: workspaceCanTogglePets(),
            canClone: canControl && pet.canHandoffToMultiPet && workspaceCanManagePets(), canDelete: false, cover: builtin)]
    }

    private func workspaceToggleInstance(_ id: String) {
        guard let row = workspacePetInstances().first(where: { $0.id == id }), row.canToggle else { return }
        if let multiPet {
            if row.isRunning { multiPet.stop(instanceID: id) } else { multiPet.start(instanceID: id) }
            rebuildMenu()
        } else { togglePetAvailability() }
        companionWorkspaceWindow?.refreshPetControls()
    }

    private func workspaceCloneInstance(_ id: String) {
        guard let row = workspacePetInstances().first(where: { $0.id == id }), row.canClone else { return }
        if let multiPet { multiPet.clone(sourceID: id) }
        else {
            beginManagedHandoff(includeClone: true) { [weak self] result in
                if case .failure(let error) = result { self?.showError(error.localizedDescription) }
                self?.companionWorkspaceWindow?.refreshPetControls()
            }
        }
        rebuildMenu()
    }

    private func workspaceDeleteInstance(_ id: String) {
        guard let row = multiPet?.instances.first(where: { $0.id == id }),
              PetInstanceDefinition.isCloneID(row.id), row.phase == .stopped || row.phase == .failed else { return }
        confirmDeleteManagedPet(instanceID: id)
    }

    private func confirmDeleteManagedPet(instanceID: String) {
        guard instanceID != "white-dragon", let multiPet,
              let row = multiPet.instances.first(where: { $0.id == instanceID }),
              multiPet.instances.count > 1, row.phase == .stopped || row.phase == .failed else { return }
        let alert = NSAlert()
        alert.messageText = "删除这个桌宠实例？"
        alert.informativeText = "将从实例清单中移除“\(PetPresentation.name(id: row.id, displayName: row.displayName))”。必须先停止并完成清理；素材包和独立状态目录会保留。原始龙妹不可删除。"
        alert.addButton(withTitle: "删除实例")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        multiPet.delete(instanceID: row.id)
        rebuildMenu()
        companionWorkspaceWindow?.refreshPetControls()
    }

    private func workspacePetStatus() -> String {
        if let multiPet {
            if let error = multiPet.lastError { return "控制器异常：\(error)" }
            if speechWarmupInProgress && multiPet.state == "idle" { return "正在准备语音互动，桌宠服务即将启动…" }
            if multiPet.isLoadingStatus { return "正在连接桌宠控制器…" }
            let rows = multiPet.instances.filter(\.enabled)
            let starting = rows.filter { $0.phase == .starting }.count
            let stopping = rows.filter { $0.phase == .stopping }.count
            let running = rows.filter { $0.phase == .running }.count
            if starting > 0 { return "正在启动 \(starting) 个桌宠 · \(running) 个运行中" }
            if stopping > 0 { return "正在停止 \(stopping) 个桌宠 · \(running) 个运行中" }
            if running > 0 { return "\(running) / \(rows.count) 个桌宠运行中" }
            if rows.isEmpty { return "暂无已启用桌宠，可在实例管理中添加或启用。" }
            if multiPet.state == "idle" { return "桌宠尚未启动 · \(rows.count) 个已就绪" }
            return "\(rows.count) 个桌宠待启动"
        }
        if let error = pet.lastError { return "启动或控制失败：\(error)" }
        if speechWarmupInProgress && pet.state == "idle" { return "正在准备语音互动，桌宠服务即将启动…" }
        switch pet.state {
        case "starting": return "正在启动桌宠…"
        case "switching": return "正在切换桌宠控制方式…"
        case "running-no-visible-window": return "桌宠服务已启动，正在等待窗口显示…"
        case "running": return "桌宠服务运行中，桌宠窗口尚未显示。"
        case "visible": return "龙妹正在桌面陪伴。"
        case "hidden": return "桌宠服务运行中，龙妹已隐藏。"
        case "not-running": return "桌宠尚未运行，点击下方按钮启动。"
        default: return "桌宠服务已停止，点击下方按钮启动。"
        }
    }

    private func workspacePetActionTitle() -> String {
        if multiPet != nil {
            if speechWarmupInProgress, multiPet?.state == "idle" { return "正在准备语音…" }
            if multiPet?.isLoadingStatus == true { return "正在连接…" }
            if multiPet?.instances.contains(where: { $0.phase == .starting }) == true { return "正在启动…" }
            if multiPet?.instances.contains(where: { $0.phase == .stopping }) == true { return "正在停止…" }
            return multiPet?.instances.contains { [.starting, .running, .stopping].contains($0.phase) } == true
                ? "停止全部桌宠" : "启动全部桌宠"
        }
        if speechWarmupInProgress && pet.state == "idle" { return "正在准备语音…" }
        if pet.state == "starting" || pet.state == "switching" { return "正在启动…" }
        return pet.isVisible ? "隐藏桌宠" : "显示桌宠"
    }

    private func workspaceCanTogglePets() -> Bool {
        guard mode != .previewCharacterWindow, !stopping, !paused else { return false }
        if let multiPet {
            if speechWarmupInProgress && multiPet.state == "idle" { return false }
            return !multiPet.isLoadingStatus && !multiPet.instances.contains {
                $0.phase == .starting || $0.phase == .stopping
            }
        }
        if speechWarmupInProgress && pet.state == "idle" { return false }
        return pet.state != "starting" && pet.state != "switching"
    }

    private func workspaceCanManagePets() -> Bool {
        if mode == .previewCharacterWindow { return !stopping }
        guard !paused, !stopping, !firstCloneInProgress,
              let candidate = multiPet ?? PetInstanceRuntime(runtime: runtime) else { return false }
        return candidate.hasValidRegistry ||
            (candidate.registryIsMissing && ExternalPetDescriptor.supportsManagedHandoff(runtime))
    }

    func replyToCharacterChat(_ text: String, history: [CharacterChatTurn],
                              memorySource: String = "用户在聊天中明确要求记住") async throws -> String {
        let store = try CharacterMemoryStore(stateDirectory: runtime.state, petID: "white-dragon")
        let identity = try await store.loadIdentity(defaultName: "龙妹")
        let memories = try await store.listMemories()
        let goals = try await store.listGoals()
        let capabilities = mode == .previewCharacterWindow
            ? CharacterCapabilitySnapshot.offlinePreview
            : CharacterCapabilitySnapshot.make(runtime: runtime, speechRuntimeAvailable: speechRuntime != nil)

        if let rememberedText = CharacterCommand.rememberText(in: text) {
            let candidate = CharacterMemory(kind: .fact, text: rememberedText, source: memorySource)
            switch CharacterMemoryReview.automationDecision(for: candidate, against: memories) {
            case .autoConfirm:
                var confirmed = candidate
                confirmed.status = .confirmed
                try await store.saveMemory(confirmed)
                return "我记下了，这条内容已保存在本机。"
            case .alreadyExists:
                return "这条内容我已经记下了，没有重复保存。"
            case .requiresReview(let reason):
                try await store.saveMemory(candidate)
                return "这条内容需要你在角色与记忆里确认：\(reason)"
            case .doNotStore:
                return "为保护账号安全，我不会保存密码、密钥或验证码。"
            }
        }

        if let localReply = CharacterLocalAnswer.answer(for: text, identity: identity,
                                                         memories: memories, capabilities: capabilities, goals: goals) {
            return localReply
        }

        guard mode != .previewCharacterWindow else {
            throw ModelProviderError.service("离线预览只支持本机身份、能力、目标和记忆问答；未连接在线服务。")
        }

        try Task.checkCancellation()
        let (provider, apiKey) = try characterChatProvider.credentials(runtime)
        let onlineCapabilities = CharacterCapabilitySnapshot.make(
            runtime: runtime, speechRuntimeAvailable: speechRuntime != nil, onlineChatReady: true
        )
        let context = CharacterContextBuilder.make(identity: identity, memories: memories,
                                                    capabilities: onlineCapabilities, goals: goals, query: text)
        try Task.checkCancellation()
        return try await characterChatProvider.complete(provider, apiKey, text, context, history)
    }

    // Bubble speech loads no ASR. Release its idle process before a conversation
    // takes ownership, without requiring the user to restart the application.
    func cancelActiveSpeechTurn() {
        speechTurnCancellation?()
    }

    func prepareConversationSpeechRuntime(releaseAnyRuntime: Bool = false,
                                          completion: @escaping (Result<Void, Error>) -> Void) {
        guard !stopping, !speechChatInProgress, !speechCueInProgress else {
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.stillStopping)); return
        }
        guard let speechRuntime else {
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.executableUnavailable)); return
        }
        guard speechRuntime.isTTSOnly || (releaseAnyRuntime && speechRuntime.isRunning) else { completion(.success(())); return }
        speechChatInProgress = true
        finishSpeechWarmup(ready: false)
        let stopped: @MainActor () -> Void = { [weak self] in
            guard let self else { return }
            self.releaseSpeechWarmupReference()
            self.speechChatInProgress = false
            guard !self.stopping else {
                completion(.failure(SpeechRuntimeSupervisor.SupervisorError.stillStopping)); return
            }
            completion(.success(()))
        }
        if !speechRuntime.isReady { speechRuntime.terminateImmediately(completion: stopped) }
        else { speechRuntime.shutdownGracefully(completion: stopped) }
    }

    private func runSpeechDemo(_ settings: SpeechSettings,
                               completion: @escaping (Result<String, Error>) -> Void) {
        prepareConversationSpeechRuntime(releaseAnyRuntime: true) { result in
            switch result {
            case .success: self.runPreparedSpeechDemo(settings, completion: completion)
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    private func runPreparedSpeechDemo(_ settings: SpeechSettings,
                                       completion: @escaping (Result<String, Error>) -> Void) {
        guard !stopping, let multiPet, multiPet.status?.instances.contains(where: {
            $0.id == "white-dragon" && $0.phase == .running
        }) == true else {
            completion(.failure(SpeechPresentationClient.ClientError.unavailable)); return
        }
        guard SpeechPresentationClient.isAvailable(directory: runtime.state) else {
            completion(.failure(SpeechPresentationClient.ClientError.unavailable)); return
        }
        guard let speechRuntime, !speechRuntime.isRunning else {
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.stillStopping)); return
        }
        let provider: ModelProviderSettings
        let apiKey: String
        do { (provider, apiKey) = try modelProviderCredentials() }
        catch { completion(.failure(error)); return }

        var audioURL: URL?
        var hasScopedAccess = false
        if settings.speakReplies {
            var stale = false
            guard let bookmark = settings.referenceAudioBookmark,
                  let resolved = resolveReferenceBookmark(bookmark, stale: &stale),
                  !stale, resolved.path == settings.referenceAudioPath else {
                completion(.failure(SpeechRuntimeSupervisor.SupervisorError.referenceUnavailable)); return
            }
            hasScopedAccess = resolved.startAccessingSecurityScopedResource()
            var audioInfo = stat()
            guard lstat(resolved.path, &audioInfo) == 0,
                  audioInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  access(resolved.path, R_OK) == 0 else {
                if hasScopedAccess { resolved.stopAccessingSecurityScopedResource() }
                completion(.failure(SpeechRuntimeSupervisor.SupervisorError.referenceUnavailable)); return
            }
            audioURL = resolved
        }

        let repository = ProcessInfo.processInfo.environment["DRAGON_DEV_ROOT"].map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL
        } ?? runtime.resources.deletingLastPathComponent()
        let ttsModel = repository.appendingPathComponent(".local/voice-runtime/models/Qwen3-TTS-12Hz-0.6B-Base-8bit")
        guard !settings.speakReplies || FileManager.default.fileExists(atPath: ttsModel.path) else {
            if hasScopedAccess { audioURL?.stopAccessingSecurityScopedResource() }
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.modelsUnavailable)); return
        }

        var arguments = ["--tts-only"]
        if settings.speakReplies { arguments += ["--tts-model", ttsModel.path, "--allow-speaker-output"] }
        if let audioURL {
            arguments += ["--reference-audio", audioURL.path,
                          "--reference-text", settings.referenceTranscript]
        }
        let stateDirectory = runtime.state
        speechChatInProgress = true
        var finished = false
        var pendingResult: Result<String, Error>?
        var sessionIdle = false
        var replyReceived = false
        var presentationResolved = !settings.displayReplies
        var presentationError: Error?
        func finish(_ result: Result<String, Error>) {
            guard !finished else { return }
            finished = true
            speechTurnTimer?.invalidate(); speechTurnTimer = nil
            speechTurnCancellation = nil
            speechReplyTask?.cancel(); speechReplyTask = nil
            speechRuntime.onEvent = nil
            speechRuntime.onExit = nil
            if hasScopedAccess { audioURL?.stopAccessingSecurityScopedResource() }
            speechChatInProgress = false
            drainPendingSpeechCue()
            completion(result)
        }
        func stopWithResult(_ result: Result<String, Error>) {
            guard !finished, pendingResult == nil else { return }
            pendingResult = result
            speechReplyTask?.cancel()
            speechRuntime.shutdownGracefully(timeout: 0.2) { finish(result) }
        }
        func finishIfReady() {
            guard sessionIdle, presentationResolved else { return }
            if let presentationError { stopWithResult(.failure(presentationError)); return }
            stopWithResult(.success(settings.displayReplies
                ? "在线模型演示完成；回复已交给龙妹气泡。没有连接直播间。"
                : "在线模型演示完成；按设置未显示回复。没有连接直播间。"))
        }
        speechTurnCancellation = { stopWithResult(.failure(SpeechRuntimeSupervisor.SupervisorError.cancelled)) }
        let watchdog = Timer(timeInterval: speechTurnTimeout, repeats: false) { _ in
            Task { @MainActor in
                guard !finished, !self.stopping else { return }
                stopWithResult(.failure(SpeechRuntimeSupervisor.SupervisorError.turnTimedOut))
            }
        }
        speechTurnTimer = watchdog
        RunLoop.main.add(watchdog, forMode: .common)
        speechRuntime.onEvent = { [weak speechRuntime] event in
            guard !finished, !self.stopping, pendingResult == nil else { return }
            if event.type == "ready" {
                self.speechReplyTask = Task {
                    do {
                        let reply = try await ModelProviderClient().complete(
                            settings: provider, apiKey: apiKey,
                            userText: "请给我一句自然的中文语音演示回复。"
                        )
                        try Task.checkCancellation()
                        guard !finished, !self.stopping else { return }
                        guard let spoken = SpeechReplyText.prepare(reply) else {
                            throw SpeechRuntimeSupervisor.SupervisorError.replyGenerationFailed
                        }
                        try speechRuntime?.sendResponse(text: spoken, speak: settings.speakReplies)
                    } catch is CancellationError { return }
                    catch { stopWithResult(.failure(error)) }
                }
                return
            }
            if event.type == "error" || (event.type == "session" && event.state == "error") {
                stopWithResult(.failure(SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: event.reason)))
                return
            }
            guard event.type == "session" else { return }
            if event.state == "reply", let reply = event.reply {
                replyReceived = true
                if settings.displayReplies {
                    Task {
                        do { try await SpeechPresentationClient.displayReplyAsync(reply, directory: stateDirectory) }
                        catch { presentationError = error }
                        guard !finished else { return }
                        presentationResolved = true
                        finishIfReady()
                    }
                }
            }
            if event.state == "idle" {
                guard replyReceived else {
                    stopWithResult(.failure(SpeechRuntimeSupervisor.SupervisorError.replyGenerationFailed)); return
                }
                sessionIdle = true
                finishIfReady()
            }
        }
        speechRuntime.onExit = { _ in
            finish(pendingResult ?? .failure(SpeechRuntimeSupervisor.SupervisorError.unexpectedExit))
        }
        do { try speechRuntime.start(appendingArguments: arguments) }
        catch { finish(.failure(error)) }
    }

    private func runVoiceChat(_ inputURL: URL, settings: SpeechSettings,
                              onTranscript: @escaping (String) -> Void,
                              completion: @escaping (Result<String, Error>) -> Void) {
        prepareConversationSpeechRuntime { result in
            switch result {
            case .success:
                self.runPreparedVoiceChat(inputURL, settings: settings, onTranscript: onTranscript,
                                          completion: completion)
            case .failure(let error):
                try? FileManager.default.removeItem(at: inputURL)
                completion(.failure(error))
            }
        }
    }

    private func runPreparedVoiceChat(_ inputURL: URL, settings: SpeechSettings,
                                      onTranscript: @escaping (String) -> Void,
                                      completion: @escaping (Result<String, Error>) -> Void) {
        let diagnostics = self.diagnostics
        diagnostics.record("speech.chat.capture-delivered")
        guard !stopping else {
            diagnostics.record("speech.chat.rejected reason=host-stopping")
            try? FileManager.default.removeItem(at: inputURL)
            completion(.failure(SpeechPresentationClient.ClientError.unavailable)); return
        }
        guard let multiPet, multiPet.status?.instances.contains(where: {
            $0.id == "white-dragon" && $0.phase == .running
        }) == true else {
            diagnostics.record("speech.chat.rejected reason=pet-not-running")
            try? FileManager.default.removeItem(at: inputURL)
            completion(.failure(SpeechPresentationClient.ClientError.unavailable)); return
        }
        guard SpeechPresentationClient.isAvailable(directory: runtime.state) else {
            diagnostics.record("speech.chat.rejected reason=presentation-unavailable")
            try? FileManager.default.removeItem(at: inputURL)
            completion(.failure(SpeechPresentationClient.ClientError.unavailable)); return
        }
        guard let speechRuntime else {
            diagnostics.record("speech.chat.rejected reason=runtime-unavailable")
            try? FileManager.default.removeItem(at: inputURL)
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.executableUnavailable)); return
        }
        guard !speechChatInProgress else {
            diagnostics.record("speech.chat.rejected reason=chat-in-progress")
            try? FileManager.default.removeItem(at: inputURL)
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.stillStopping)); return
        }
        var inputInfo = stat()
        guard lstat(inputURL.path, &inputInfo) == 0,
              inputInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              inputInfo.st_size > 44, inputInfo.st_size <= 16 * 1024 * 1024,
              access(inputURL.path, R_OK) == 0 else {
            diagnostics.record("speech.chat.rejected reason=audio-file-invalid")
            try? FileManager.default.removeItem(at: inputURL)
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.referenceUnavailable)); return
        }

        let repository = ProcessInfo.processInfo.environment["DRAGON_DEV_ROOT"].map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL
        } ?? runtime.resources.deletingLastPathComponent()
        let modelRoot = repository.appendingPathComponent(".local/voice-runtime/models")
        let asrModel = modelRoot.appendingPathComponent("Qwen3-ASR-0.6B-8bit")
        let ttsModel = modelRoot.appendingPathComponent("Qwen3-TTS-12Hz-0.6B-Base-8bit")
        guard FileManager.default.fileExists(atPath: asrModel.path) else {
            diagnostics.record("speech.chat.rejected reason=models-unavailable")
            try? FileManager.default.removeItem(at: inputURL)
            completion(.failure(SpeechRuntimeSupervisor.SupervisorError.modelsUnavailable)); return
        }

        var referenceURL: URL?
        var hasScopedAccess = false
        var arguments = ["--asr-model", asrModel.path]
        if settings.speakReplies {
            var stale = false
            guard let bookmark = settings.referenceAudioBookmark,
                  let resolved = resolveReferenceBookmark(bookmark, stale: &stale),
                  !stale, resolved.path == settings.referenceAudioPath,
                  !settings.referenceTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  (!settings.speakReplies || FileManager.default.fileExists(atPath: ttsModel.path)) else {
                diagnostics.record("speech.chat.rejected reason=reference-unavailable")
                try? FileManager.default.removeItem(at: inputURL)
                completion(.failure(SpeechRuntimeSupervisor.SupervisorError.referenceUnavailable)); return
            }
            hasScopedAccess = resolved.startAccessingSecurityScopedResource()
            var referenceInfo = stat()
            guard lstat(resolved.path, &referenceInfo) == 0,
                  referenceInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  access(resolved.path, R_OK) == 0 else {
                diagnostics.record("speech.chat.rejected reason=reference-unreadable")
                if hasScopedAccess { resolved.stopAccessingSecurityScopedResource() }
                try? FileManager.default.removeItem(at: inputURL)
                completion(.failure(SpeechRuntimeSupervisor.SupervisorError.referenceUnavailable)); return
            }
            referenceURL = resolved
            if settings.speakReplies {
                arguments += ["--tts-model", ttsModel.path, "--reference-audio", resolved.path,
                              "--reference-text", settings.referenceTranscript, "--allow-speaker-output"]
            }
        }

        let stateDirectory = runtime.state
        speechChatInProgress = true
        let turnStartedAt = ProcessInfo.processInfo.systemUptime
        func recordTiming(_ stage: String) {
            let elapsedMilliseconds = Int((ProcessInfo.processInfo.systemUptime - turnStartedAt) * 1_000)
            diagnostics.record("speech.timing stage=\(stage) elapsed-ms=\(elapsedMilliseconds)")
        }
        diagnostics.record("speech.chat.accepted audio-bytes=\(inputInfo.st_size) speak=\(settings.speakReplies) display=\(settings.displayReplies)")
        var finished = false
        var transcript: String?
        var sessionReachedIdle = false
        var presentationResolved = !settings.displayReplies
        var presentationError: Error?
        var shutdownStarted = false
        var replyWasReceived = false
        var inputResourcesReleased = false
        var pendingFailure: Error?
        var restartingForTurn = false
        func releaseInputResources() {
            guard !inputResourcesReleased else { return }
            inputResourcesReleased = true
            try? FileManager.default.removeItem(at: inputURL)
            if hasScopedAccess { referenceURL?.stopAccessingSecurityScopedResource() }
        }

        func finish(_ result: Result<String, Error>) {
            guard !finished else { return }
            finished = true
            speechTurnTimer?.invalidate(); speechTurnTimer = nil
            speechTurnCancellation = nil
            speechReplyTask?.cancel(); speechReplyTask = nil
            speechRuntime.onEvent = nil
            speechRuntime.onExit = nil
            releaseInputResources()
            speechChatInProgress = false
            drainPendingSpeechCue()
            switch result {
            case .success: diagnostics.record("speech.chat.finished result=success")
            case .failure: diagnostics.record("speech.chat.finished result=failure")
            }
            completion(result)
        }

        func fail(_ error: Error) {
            guard !finished, pendingFailure == nil else { return }
            pendingFailure = error
            speechReplyTask?.cancel()
            speechTurnTimer?.invalidate(); speechTurnTimer = nil
            speechRuntime.shutdownGracefully(timeout: 0.2) { finish(.failure(error)) }
        }

        speechTurnCancellation = { fail(SpeechRuntimeSupervisor.SupervisorError.cancelled) }
        let watchdog = Timer(timeInterval: speechTurnTimeout, repeats: false) { _ in
            Task { @MainActor in
                guard !finished, !self.stopping else { return }
                self.diagnostics.record("speech.chat.timed-out")
                fail(SpeechRuntimeSupervisor.SupervisorError.turnTimedOut)
            }
        }
        speechTurnTimer = watchdog
        RunLoop.main.add(watchdog, forMode: .common)

        func finishSessionIfReady() {
            guard sessionReachedIdle, presentationResolved, !shutdownStarted else { return }
            shutdownStarted = true
            releaseInputResources()
            diagnostics.record("speech.runtime.kept-warm")
            if let presentationError {
                if case SpeechPresentationClient.ClientError.rejected("pet_busy") = presentationError {
                    let outcome = settings.speakReplies ? "语音回复已生成并朗读" : "文字回复已生成"
                    finish(.success("\(outcome)，但龙妹一直忙碌，未能显示气泡；请等当前动作结束后再试。"))
                } else {
                    finish(.failure(presentationError))
                }
                return
            }
            let message = settings.speakReplies
                ? (settings.displayReplies ? "语音识别与回复完成，已显示并朗读。" : "语音识别与回复完成，已朗读；按设置未显示气泡。")
                : "语音识别与回复完成；本轮只处理文字，没有播放声音。"
            finish(.success(transcript == nil ? "没有识别到有效语音。" : message))
        }

        func submitTranscription() {
            do {
                try speechRuntime.sendTranscription(audioURL: inputURL)
                diagnostics.record("speech.asr.submitted")
            } catch {
                diagnostics.record("speech.asr.submit-failed")
                fail(error)
            }
        }

        func presentReply(_ reply: String, attempt: Int = 0) {
            guard !finished, !self.stopping else { return }
            Task {
                do {
                    try await SpeechPresentationClient.displayReplyAsync(reply, directory: stateDirectory)
                    guard !finished, !self.stopping else { return }
                    diagnostics.record("speech.presentation.accepted characters=\(reply.count) attempt=\(attempt + 1)")
                    presentationResolved = true
                    finishSessionIfReady()
                } catch let error as SpeechPresentationClient.ClientError {
                    guard !finished, !self.stopping else { return }
                    if case .rejected("pet_busy") = error, attempt < 20 {
                        diagnostics.record("speech.presentation.retry attempt=\(attempt + 1) reason=pet-busy")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                            presentReply(reply, attempt: attempt + 1)
                        }
                        return
                    }
                    diagnostics.record("speech.presentation.rejected reason=\(error.localizedDescription)")
                    presentationError = error
                    presentationResolved = true
                    finishSessionIfReady()
                } catch {
                    guard !finished, !self.stopping else { return }
                    diagnostics.record("speech.presentation.failed")
                    presentationError = error
                    presentationResolved = true
                    finishSessionIfReady()
                }
            }
        }

        speechRuntime.onEvent = { [weak speechRuntime] event in
            guard !finished, !self.stopping, pendingFailure == nil else { return }
            if event.type == "ready" {
                diagnostics.record("speech.runtime.ready")
                recordTiming("runtime-ready")
                submitTranscription()
                return
            }
            if event.type == "transcription", let text = event.text, !text.isEmpty {
                transcript = text
                diagnostics.record("speech.asr.received characters=\(text.count)")
                recordTiming("asr-finished")
                onTranscript(text)
                self.speechReplyTask = Task {
                    do {
                        let reply = try await self.replyToCharacterChat(text, history: [], memorySource: "用户语音明确指令")
                        try Task.checkCancellation()
                        guard !finished, !self.stopping else { return }
                        guard let spoken = SpeechReplyText.prepare(reply) else {
                            throw SpeechRuntimeSupervisor.SupervisorError.replyGenerationFailed
                        }
                        try speechRuntime?.sendResponse(text: spoken, speak: settings.speakReplies)
                        diagnostics.record("speech.reply.submitted characters=\(spoken.count)")
                    } catch is CancellationError {
                        return
                    } catch {
                        guard !finished, !self.stopping else { return }
                        diagnostics.record("speech.reply.submit-failed")
                        fail(error)
                    }
                }
                return
            }
            if event.type == "error" {
                diagnostics.record("speech.runtime.error reason=\(event.reason ?? "unknown")")
                let error = SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: event.reason)
                fail(error)
                return
            }
            guard event.type == "session", let eventState = event.state else { return }
            diagnostics.record("speech.session state=\(eventState) reason=\(event.reason ?? "none")")
            if eventState == "audio_started" { recordTiming("first-audio-chunk") }
            if eventState == "reply", let reply = event.reply {
                diagnostics.record("speech.reply.received characters=\(reply.count)")
                recordTiming("reply-generated")
                replyWasReceived = true
                if settings.displayReplies { presentReply(reply) }
            }
            if eventState == "error" {
                fail(SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: event.reason))
                return
            }
            if eventState == "idle" {
                recordTiming("turn-idle")
                guard replyWasReceived else {
                    fail(SpeechRuntimeSupervisor.SupervisorError.replyGenerationFailed); return
                }
                sessionReachedIdle = true
                finishSessionIfReady()
            }
        }
        speechRuntime.onExit = { status in
            diagnostics.record("speech.runtime.exited status=\(status)")
            if restartingForTurn && pendingFailure == nil && !self.stopping { return }
            finish(.failure(pendingFailure ?? SpeechRuntimeSupervisor.SupervisorError.unexpectedExit))
        }
        do {
            if speechRuntime.isRunning {
                guard speechRuntime.isRunning(withAdditionalArguments: arguments) else {
                    restartingForTurn = true
                    speechRuntime.shutdownGracefully {
                        guard !finished, pendingFailure == nil, !self.stopping else { return }
                        restartingForTurn = false
                        do { try speechRuntime.start(appendingArguments: arguments) }
                        catch { finish(.failure(error)) }
                    }
                    return
                }
                diagnostics.record("speech.runtime.reused")
                recordTiming("warm-runtime")
                submitTranscription()
            } else {
                diagnostics.record("speech.runtime.starting")
                try speechRuntime.start(appendingArguments: arguments)
            }
        }
        catch {
            diagnostics.record("speech.runtime.start-failed")
            finish(.failure(error))
        }
    }

    private func resolveReferenceBookmark(_ bookmark: Data, stale: inout Bool) -> URL? {
        if let scoped = try? URL(resolvingBookmarkData: bookmark, options: .withSecurityScope,
                                 relativeTo: nil, bookmarkDataIsStale: &stale) {
            return scoped
        }
        return try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil,
                        bookmarkDataIsStale: &stale)
    }

    private func modelProviderCredentials() throws -> (ModelProviderSettings, String) {
        let provider = try ModelProviderStore(stateDirectory: runtime.state).load()
        guard let key = try ModelAPIKeyStore().read()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else { throw ModelProviderError.missingAPIKey }
        return (provider, key)
    }

    private func addLocalPets(_ packages: [PetPackageReference], completion: @escaping (Result<String, Error>) -> Void) {
        guard !stopping, !paused, !firstCloneInProgress else {
            completion(.failure(ConfigurationError("当前已暂停、正在退出或正在切换桌宠；未登记新实例。")))
            return
        }
        let add: () -> Void = { [weak self] in
            guard let self, let controller = self.multiPet else {
                completion(.failure(ConfigurationError("实例控制器不可用；未登记桌宠。")))
                return
            }
            Task { @MainActor in
                do {
                    let reply = try await controller.addPets(packages)
                    guard reply.ok, let result = reply.result else {
                        throw ConfigurationError(reply.error?.message ?? "控制器未确认添加，请核对实例管理。")
                    }
                    let added = result.outcomes.filter(\.changed).count
                    let existing = result.outcomes.count - added
                    completion(.success("已添加\(added)只桌宠（保持停止）\(existing > 0 ? "，\(existing)只已存在" : "")；可从实例管理启动。"))
                } catch { completion(.failure(error)) }
                self.rebuildMenu()
            }
        }
        if multiPet != nil { add(); return }
        beginManagedHandoff(includeClone: false) { result in
            switch result {
            case .success: add()
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    @objc private func createFirstClone() {
        beginManagedHandoff(includeClone: true) { [weak self] result in
            switch result {
            case .success: self?.showNotice("龙妹分身已创建并保持停止。原宠已交由多实例控制器恢复；可在“实例管理”中单独启动分身。")
            case .failure(let error): self?.showError(error.localizedDescription)
            }
        }
    }

    private func beginManagedHandoff(includeClone: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        guard !firstCloneInProgress, !stopping, !paused, multiPet == nil,
              let candidate = PetInstanceRuntime(runtime: runtime), candidate.registryIsMissing,
              pet.canHandoffToMultiPet, ExternalPetDescriptor.supportsManagedHandoff(runtime) else {
            completion(.failure(ConfigurationError("请先显示由桌边小崽启动的增强龙妹；已有或无效实例清单不会被覆盖。")))
            return
        }
        firstCloneInProgress = true
        rebuildMenu()
        Task { @MainActor [weak self] in
            guard let self else { return }
            let runtime = self.runtime
            let inspected = await Task.detached(priority: .utility) {
                Result { try ExternalPetDescriptor.inspect(runtime) }
            }.value
            guard !self.stopping else {
                self.firstCloneInProgress = false
                completion(.failure(ConfigurationError("宿主正在退出；未切换控制器。")))
                return
            }
            let assets: URL
            switch inspected {
            case .success(let descriptor):
                guard let root = descriptor.assetsURL else {
                    self.firstCloneInProgress = false
                    self.rebuildMenu()
                    completion(.failure(ConfigurationError("当前龙妹素材身份无法用于实例管理。")))
                    return
                }
                assets = root
            case .failure(let error):
                self.firstCloneInProgress = false
                self.rebuildMenu()
                completion(.failure(error))
                return
            }
            let confirmation = NSAlert()
            confirmation.messageText = "切换到桌宠实例管理？"
            confirmation.informativeText = "桌边小崽将请求当前由本宿主启动的龙妹安全退出，再由一个多实例控制器恢复原宠。" +
                (includeClone ? "同时登记一个已停止的龙妹分身。" : "本次只接管原宠，所选新桌宠添加后保持停止。") +
                "取消不改变运行状态；若退出未确认，不会启动第二个控制器。"
            confirmation.alertStyle = .warning
            confirmation.addButton(withTitle: includeClone ? "切换并创建" : "切换并添加")
            confirmation.addButton(withTitle: "取消")
            guard confirmation.runModal() == .alertFirstButtonReturn else {
                self.firstCloneInProgress = false
                self.rebuildMenu()
                completion(.failure(ConfigurationError("已取消，当前桌宠保持原状。")))
                return
            }
            self.pet.handoffToMultiPet { [weak self] result in
                guard let self else { return }
                guard !self.stopping else {
                    self.firstCloneInProgress = false
                    completion(.failure(ConfigurationError("宿主正在退出；请重新打开后核对实例清单。")))
                    return
                }
                switch result {
                case .failure(let error):
                    self.firstCloneInProgress = false
                    self.rebuildMenu()
                    completion(.failure(error))
                case .success(let preferences):
                    guard let manager = PetInstanceRuntime(runtime: self.runtime) else {
                        self.firstCloneInProgress = false
                        self.rebuildMenu()
                        completion(.failure(ConfigurationError("多实例 helper 不可用；原宠已停止，没有启动竞争控制器。请重新打开桌边小崽检查构建。")))
                        return
                    }
                    self.configure(manager)
                    self.multiPet = manager
                    manager.createInitialPair(assets: assets, preferences: preferences, includeClone: includeClone) { [weak self] result in
                        self?.firstCloneInProgress = false
                        self?.rebuildMenu()
                        completion(result)
                    }
                    self.rebuildMenu()
                }
            }
        }
    }

    private func configure(_ manager: PetInstanceRuntime) {
        manager.taskFollowingAllowed = mode == .watch || mode == .launch
        manager.onDiagnostic = { [weak self] event in self?.diagnostics.record(event) }
        manager.onChanged = { [weak self, weak manager] in
            guard let self else { return }
            self.diagnostics.record("multi-pet.changed state=\(manager?.state ?? "unknown")")
            self.rebuildMenu()
        }
    }

    private func showNotice(_ text: String) {
        let alert = NSAlert(); alert.messageText = AppCopy.name; alert.informativeText = text
        alert.addButton(withTitle: "好"); alert.runModal()
    }

    @objc private func toggleManagedPet(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? PetMenuAction,
              let multiPet,
              let row = multiPet.instances.first(where: { $0.id == action.instanceID }) else { return }
        if row.phase == .running || row.phase == .starting {
            multiPet.stop(instanceID: action.instanceID)
        } else if row.phase != .stopping {
            multiPet.start(instanceID: action.instanceID)
        }
        rebuildMenu()
    }
    @objc private func setManagedPetSize(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? PetMenuAction,
              let size = action.size else { return }
        multiPet?.setSize(size, for: action.instanceID)
        rebuildMenu()
    }
    @objc private func deleteManagedPet(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? PetMenuAction else { return }
        confirmDeleteManagedPet(instanceID: action.instanceID)
    }
    @objc private func togglePause() {
        guard mode != .previewCharacterWindow else { return }
        _ = handle(.init(paused ? .resume : .pause))
    }
    @objc private func quit() { _ = handle(.init(.quit)) }
    @objc private func openWindowPermissionSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else { return }
        NSWorkspace.shared.open(url)
    }
    @objc private func openSettings() { NSWorkspace.shared.open(runtime.state) }
}
