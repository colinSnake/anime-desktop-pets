import AppKit
import CharacterCore
import CharacterMemory
import ApplicationServices
import DragonCore

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
    enum Mode: Equatable { case launch, watch, previewAnimation, previewPet, controlTest }
    private let runtime: Runtime
    private let mode: Mode
    private let diagnostics: Diagnostics
    private var session = LaunchSession()
    private var target: NSRunningApplication?
    private var pet: PetController
    private var multiPet: PetInstanceRuntime?
    private var speechRuntime: SpeechRuntimeSupervisor?
    private var speechChatInProgress = false
    private var speechSettingsWindow: SpeechSettingsWindow?
    private var modelManagerWindow: ModelManagerWindow?
    private var characterWindow: CharacterWindow?
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

    init(runtime: Runtime, mode: Mode) {
        self.runtime = runtime; self.mode = mode
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
        pet.onChanged = { [weak self] in self?.rebuildMenu() }
        pet.onHide = { [weak self] in _ = self?.handle(.init(.hide)) }
        multiPet?.onChanged = { [weak self] in
            guard let self, let multiPet = self.multiPet else { return }
            var snapshot = (try? JSONEncoder().encode(multiPet.instances)) ?? Data()
            snapshot.append(contentsOf: "|\(multiPet.state)|\(multiPet.isLoadingStatus)|\(multiPet.lastError ?? "")".utf8)
            guard snapshot != self.lastMultiPetSnapshot else { return }
            self.lastMultiPetSnapshot = snapshot
            self.diagnostics.record("multi-pet.changed state=\(multiPet.state)")
            self.rebuildMenu()
        }
        multiPet?.onDiagnostic = { [weak self] event in self?.diagnostics.record(event) }
    }

    func start() {
        diagnostics.record("controller.start mode=\(mode)")
        guard mode != .controlTest else { return }
        createMenu()
        if multiPet?.isConfigured == true, mode != .previewAnimation { multiPet?.start() }
        if mode == .previewPet { showPetRuntime(near: nil); return }
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
        if let multiPet {
            if startAllManaged { multiPet.startEnabledInstances() }
            else { multiPet.restoreAutoStartedInstances() }
        } else {
            pet.show(near: frame)
        }
    }

    private func hidePetRuntime() {
        if let multiPet { multiPet.stopAllInstances() } else { pet.hide() }
    }

    private func dismissPetRuntime() {
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
        }
        rebuildMenu()
        return snapshot("\(request.command.rawValue) 已处理")
    }
    func snapshot(_ message: String = AppCopy.runningMessage) -> CompanionStatus {
        CompanionStatus(message: message, phase: session.phase.rawValue, codexPID: session.pid, paused: paused,
                        petVisible: multiPet?.isVisible ?? pet.isVisible, backend: multiPet == nil ? runtime.configuration.petBackend : "external-multi",
                        posterReady: FileManager.default.fileExists(atPath: runtime.posterURL.path),
                        petState: multiPet?.state ?? pet.state, petError: multiPet?.lastError ?? pet.lastError)
    }
    func stop() {
        stopping = true
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
        let menu = self.menu ?? NSMenu()
        menu.delegate = self; menu.removeAllItems()
        let backendLabel = runtime.configuration.petBackend == "external" ? "动画桌宠" : "静态预览"
        let statusLabel = (multiPet?.lastError ?? pet.lastError).map { "运行异常：\($0.prefix(72))" }
            ?? (paused ? "已暂停" : backendLabel)
        let label = NSMenuItem(title: "\(AppCopy.name) · \(statusLabel)", action: nil, keyEquivalent: "")
        label.isEnabled = false; menu.addItem(label); menu.addItem(.separator())
        if let multiPet {
            let enabled = multiPet.instances.filter(\.enabled).count
            let active = multiPet.instances.filter { [.starting, .running, .stopping].contains($0.phase) }.count
            let summary = NSMenuItem(title: "\(active) / \(enabled) 个实例运行中", action: nil, keyEquivalent: "")
            summary.isEnabled = false; menu.addItem(summary)
        }
        func item(_ title: String, _ selector: Selector) { let i = NSMenuItem(title: title, action: selector, keyEquivalent: ""); i.target = self; menu.addItem(i) }
        let activeManagedPets = multiPet?.instances.contains { [.starting, .running, .stopping].contains($0.phase) } == true
        let primaryAction = multiPet != nil
            ? (activeManagedPets ? "停止全部桌宠" : "启动全部桌宠")
            : (pet.isVisible ? "隐藏桌宠" : "显示桌宠")
        if mode != .previewAnimation {
            if paused {
                item("恢复陪伴", #selector(togglePause))
            } else if mode == .watch && session.pid == nil {
                let waiting = NSMenuItem(title: "等待应用启动", action: nil, keyEquivalent: "")
                waiting.isEnabled = false; menu.addItem(waiting)
            } else {
                item(primaryAction, #selector(togglePetAvailability))
            }
        }
        if let management = petManagementMenu() {
            let managementItem = NSMenuItem(title: "实例管理", action: nil, keyEquivalent: "")
            managementItem.submenu = management
            menu.addItem(managementItem)
        }
        if mode != .previewAnimation && mode != .controlTest {
            let modelManager = NSMenuItem(title: "模型管理", action: #selector(openModelManager), keyEquivalent: "")
            modelManager.target = self
            menu.addItem(modelManager)
            let speechSettings = NSMenuItem(title: "直播语音设置", action: #selector(openSpeechSettings), keyEquivalent: "")
            speechSettings.target = self
            menu.addItem(speechSettings)
            let character = NSMenuItem(title: "角色与记忆", action: #selector(openCharacterWindow), keyEquivalent: "")
            character.target = self
            menu.addItem(character)
        }
        if mode != .previewAnimation, multiPet == nil, runtime.configuration.petBackend == "external" {
            if let candidate = PetInstanceRuntime(runtime: runtime), candidate.registryIsMissing {
                menu.addItem(.separator())
                if ExternalPetDescriptor.supportsManagedHandoff(runtime) {
                    let create = NSMenuItem(title: firstCloneInProgress ? "正在切换桌宠" : "创建龙妹分身",
                                            action: firstCloneInProgress ? nil : #selector(createFirstClone), keyEquivalent: "")
                    create.target = self
                    create.isEnabled = !firstCloneInProgress && !paused && pet.canHandoffToMultiPet
                    if !pet.canHandoffToMultiPet { create.title = "先显示由桌边小崽启动的增强龙妹" }
                    menu.addItem(create)
                } else {
                    let unavailable = NSMenuItem(title: "当前龙妹构建不支持安全分身切换", action: nil, keyEquivalent: "")
                    unavailable.isEnabled = false; menu.addItem(unavailable)
                }
            } else if let candidate = PetInstanceRuntime(runtime: runtime), !candidate.hasValidRegistry {
                menu.addItem(.separator())
                let unavailable = NSMenuItem(title: "实例清单无效；为保护现有数据，已停用首次创建入口", action: nil, keyEquivalent: "")
                unavailable.isEnabled = false; menu.addItem(unavailable)
            } else if PetInstanceRuntime(runtime: runtime) == nil {
                let unavailable = NSMenuItem(title: "当前桌宠构建不支持实例管理", action: nil, keyEquivalent: "")
                unavailable.isEnabled = false; menu.addItem(unavailable)
            }
        }
        if mode == .watch || mode == .launch {
            menu.addItem(.separator()); item(paused ? "恢复联动" : "暂停联动", #selector(togglePause))
        }
        let advanced = NSMenu()
        advanced.title = "高级"
        if !AXIsProcessTrusted() {
            let permission = NSMenuItem(title: "允许关联窗口大小", action: #selector(openWindowPermissionSettings), keyEquivalent: "")
            permission.target = self; advanced.addItem(permission)
        }
        let settings = NSMenuItem(title: "打开数据文件夹", action: #selector(openSettings), keyEquivalent: "")
        settings.target = self; advanced.addItem(settings)
        let advancedItem = NSMenuItem(title: "高级", action: nil, keyEquivalent: "")
        advancedItem.submenu = advanced
        menu.addItem(advancedItem)
        menu.addItem(.separator()); item(AppCopy.quitTitle, #selector(quit))
        statusItem?.menu = menu; self.menu = menu
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
        if let multiPet {
            let active = multiPet.instances.contains { [.starting, .running, .stopping].contains($0.phase) }
            _ = handle(.init(active ? .hide : .show))
        } else if pet.isVisible {
            hidePet()
        } else if multiPet != nil {
            _ = handle(.init(.show))
        } else {
            showPet()
        }
        rebuildMenu()
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
                let window = try PetManagerWindow(runtime: runtime)
                window.addPackages = { [weak self] packages, completion in
                    guard let self else { return }
                    self.addLocalPets(packages, completion: completion)
                }
                petManagerWindow = window
            }
            petManagerWindow?.open()
        } catch { showError(error.localizedDescription) }
    }

    @objc private func openSpeechSettings() {
        guard !stopping else { return }
        do {
            if speechSettingsWindow == nil {
                let window = try SpeechSettingsWindow(store: SpeechSettingsStore(stateDirectory: runtime.state))
                window.onDemo = { [weak self] settings, completion in
                    self?.runSpeechDemo(settings, completion: completion)
                }
                window.onDiagnostic = { [weak self] event in
                    self?.diagnostics.record(event)
                }
                window.onVoiceChat = { [weak self] audioURL, settings, onTranscript, completion in
                    self?.runVoiceChat(audioURL, settings: settings, onTranscript: onTranscript,
                                       completion: completion)
                }
                speechSettingsWindow = window
            }
            speechSettingsWindow?.showWindow(nil)
            speechSettingsWindow?.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } catch {
            showError(error.localizedDescription)
        }
    }

    @objc private func openModelManager() {
        guard !stopping else { return }
        do {
            if modelManagerWindow == nil {
                modelManagerWindow = try ModelManagerWindow(store: ModelProviderStore(stateDirectory: runtime.state))
            }
            modelManagerWindow?.showWindow(nil)
            modelManagerWindow?.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } catch { showError(error.localizedDescription) }
    }

    @objc private func openCharacterWindow() {
        guard !stopping else { return }
        do {
            if characterWindow == nil {
                let store = try CharacterMemoryStore(stateDirectory: runtime.state, petID: "white-dragon")
                let capabilities = CharacterCapabilitySnapshot.make(runtime: runtime,
                                                                      speechRuntimeAvailable: speechRuntime != nil)
                characterWindow = CharacterWindow(
                    store: store,
                    capabilities: capabilities,
                    suggestGoal: { [weak self] title, details in
                        guard let self else { throw ModelProviderError.service("桌边小崽已关闭") }
                        let (provider, apiKey) = try self.modelProviderCredentials()
                        return try await ModelProviderClient().suggestGoalSteps(
                            settings: provider, apiKey: apiKey, title: title, details: details
                        )
                    }
                )
            }
            characterWindow?.showWindow(nil)
            characterWindow?.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } catch { showError(error.localizedDescription) }
    }

    private func runSpeechDemo(_ settings: SpeechSettings,
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

        var arguments: [String] = []
        if settings.speakReplies { arguments += ["--tts-model", ttsModel.path, "--allow-speaker-output"] }
        if let audioURL {
            arguments += ["--reference-audio", audioURL.path,
                          "--reference-text", settings.referenceTranscript]
        }
        let stateDirectory = runtime.state
        var finished = false
        func finish(_ result: Result<String, Error>) {
            guard !finished else { return }
            finished = true
            completion(result)
        }

        speechRuntime.onEvent = { [weak speechRuntime] event in
            guard !finished else { return }
            if event.type == "ready" {
                Task {
                    do {
                        let reply = try await ModelProviderClient().complete(
                            settings: provider, apiKey: apiKey,
                            userText: "请给我一句自然的中文语音演示回复。"
                        )
                        try speechRuntime?.sendResponse(text: reply, speak: settings.speakReplies)
                    } catch { speechRuntime?.shutdownGracefully { finish(.failure(error)) } }
                }
                return
            }
            if event.type == "error" {
                let error = SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: event.reason)
                speechRuntime?.shutdownGracefully { finish(.failure(error)) }
                return
            }
            guard event.type == "session", let eventState = event.state else { return }
            if eventState == "reply", let reply = event.reply, settings.displayReplies {
                do { try SpeechPresentationClient.displayReply(reply, directory: stateDirectory) }
                catch { speechRuntime?.shutdownGracefully { finish(.failure(error)) }; return }
            }
            if eventState == "error" {
                speechRuntime?.shutdownGracefully { finish(.failure(SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: event.reason))) }
            } else if eventState == "idle" {
                speechRuntime?.shutdownGracefully {
                    finish(.success(settings.displayReplies
                        ? "在线模型演示完成；回复已交给龙妹气泡。没有连接直播间。"
                        : "在线模型演示完成；按设置未显示回复。没有连接直播间。"))
                }
            }
        }
        speechRuntime.onExit = { status in
            if hasScopedAccess { audioURL?.stopAccessingSecurityScopedResource() }
            if status != 0 { finish(.failure(SpeechRuntimeSupervisor.SupervisorError.inferenceFailed)) }
        }
        do { try speechRuntime.start(appendingArguments: arguments) }
        catch {
            if hasScopedAccess { audioURL?.stopAccessingSecurityScopedResource() }
            completion(.failure(error))
        }
    }

    private func runVoiceChat(_ inputURL: URL, settings: SpeechSettings,
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
        func releaseInputResources() {
            guard !inputResourcesReleased else { return }
            inputResourcesReleased = true
            try? FileManager.default.removeItem(at: inputURL)
            if hasScopedAccess { referenceURL?.stopAccessingSecurityScopedResource() }
        }

        func finish(_ result: Result<String, Error>) {
            guard !finished else { return }
            finished = true
            speechChatInProgress = false
            switch result {
            case .success: diagnostics.record("speech.chat.finished result=success")
            case .failure: diagnostics.record("speech.chat.finished result=failure")
            }
            completion(result)
        }

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
                speechRuntime.shutdownGracefully { finish(.failure(error)) }
            }
        }

        func presentReply(_ reply: String, attempt: Int = 0) {
            guard !finished else { return }
            do {
                try SpeechPresentationClient.displayReply(reply, directory: stateDirectory)
                diagnostics.record("speech.presentation.accepted characters=\(reply.count) attempt=\(attempt + 1)")
                presentationResolved = true
                finishSessionIfReady()
            } catch let error as SpeechPresentationClient.ClientError {
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
                diagnostics.record("speech.presentation.failed")
                presentationError = error
                presentationResolved = true
                finishSessionIfReady()
            }
        }

        speechRuntime.onEvent = { [weak speechRuntime] event in
            guard !finished else { return }
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
                if let rememberedText = CharacterCommand.rememberText(in: text) {
                    Task {
                        do {
                            let store = try CharacterMemoryStore(stateDirectory: self.runtime.state, petID: "white-dragon")
                            let candidate = CharacterMemory(
                                kind: .fact, text: rememberedText, source: "用户语音明确指令"
                            )
                            let existing = try await store.listMemories()
                            switch CharacterMemoryReview.automationDecision(for: candidate, against: existing) {
                            case .autoConfirm:
                                var confirmed = candidate
                                confirmed.status = .confirmed
                                try await store.saveMemory(confirmed)
                                try speechRuntime?.sendResponse(
                                    text: "我记下了，这条内容已保存在本机。",
                                    speak: settings.speakReplies
                                )
                            case .alreadyExists:
                                try speechRuntime?.sendResponse(
                                    text: "这条内容我已经记下了，没有重复保存。",
                                    speak: settings.speakReplies
                                )
                            case .requiresReview(let reason):
                                try await store.saveMemory(candidate)
                                try speechRuntime?.sendResponse(
                                    text: "这条内容需要你在角色与记忆里确认：\(reason)",
                                    speak: settings.speakReplies
                                )
                            case .doNotStore:
                                try speechRuntime?.sendResponse(
                                    text: "为保护账号安全，我不会保存密码、密钥或验证码。",
                                    speak: settings.speakReplies
                                )
                            }
                        } catch {
                            diagnostics.record("character.memory.candidate-failed")
                            speechRuntime?.shutdownGracefully { finish(.failure(error)) }
                        }
                    }
                    return
                }
                Task {
                    do {
                        let store = try CharacterMemoryStore(stateDirectory: self.runtime.state, petID: "white-dragon")
                        let identity = try await store.loadIdentity(defaultName: "龙妹")
                        let memories = try await store.listMemories()
                        let localCapabilities = CharacterCapabilitySnapshot.make(runtime: self.runtime,
                                                                                  speechRuntimeAvailable: self.speechRuntime != nil)
                        if let localReply = CharacterLocalAnswer.answer(for: text, identity: identity,
                                                                         memories: memories,
                                                                         capabilities: localCapabilities) {
                            try speechRuntime?.sendResponse(text: localReply, speak: settings.speakReplies)
                            diagnostics.record("character.local-answer")
                            return
                        }
                        let characterContext = await self.voiceCharacterContext(for: text)
                        let (provider, apiKey) = try self.modelProviderCredentials()
                        let reply = try await ModelProviderClient().complete(
                            settings: provider, apiKey: apiKey, userText: text,
                            characterContext: characterContext
                        )
                        try speechRuntime?.sendResponse(text: reply, speak: settings.speakReplies)
                        diagnostics.record("speech.reply.requested provider=online")
                    } catch {
                        diagnostics.record("speech.reply.submit-failed")
                        speechRuntime?.shutdownGracefully { finish(.failure(error)) }
                    }
                }
                return
            }
            if event.type == "error" {
                diagnostics.record("speech.runtime.error reason=\(event.reason ?? "unknown")")
                let error = SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: event.reason)
                speechRuntime?.shutdownGracefully {
                    finish(.failure(error))
                }
                return
            }
            guard event.type == "session", let eventState = event.state else { return }
            diagnostics.record("speech.session state=\(eventState) reason=\(event.reason ?? "none")")
            if eventState == "audio_started" { recordTiming("first-audio-chunk") }
            if eventState == "reply", let reply = event.reply, settings.displayReplies {
                diagnostics.record("speech.reply.received characters=\(reply.count)")
                recordTiming("reply-generated")
                replyWasReceived = true
                presentReply(reply)
            }
            if eventState == "error" {
                speechRuntime?.shutdownGracefully {
                    finish(.failure(SpeechRuntimeSupervisor.SupervisorError.runtimeFailure(reason: event.reason)))
                }
                return
            }
            if eventState == "idle" {
                recordTiming("turn-idle")
                if !replyWasReceived { presentationResolved = true }
                sessionReachedIdle = true
                finishSessionIfReady()
            }
        }
        speechRuntime.onExit = { status in
            releaseInputResources()
            diagnostics.record("speech.runtime.exited status=\(status)")
            if status != 0 { finish(.failure(SpeechRuntimeSupervisor.SupervisorError.inferenceFailed)) }
        }
        do {
            if speechRuntime.isRunning {
                guard speechRuntime.isRunning(withAdditionalArguments: arguments) else {
                    throw SpeechRuntimeSupervisor.SupervisorError.configurationChanged
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
            speechChatInProgress = false
            try? FileManager.default.removeItem(at: inputURL)
            if hasScopedAccess { referenceURL?.stopAccessingSecurityScopedResource() }
            diagnostics.record("speech.runtime.start-failed")
            completion(.failure(error))
        }
    }

    private func voiceCharacterContext(for query: String) async -> String? {
        do {
            let store = try CharacterMemoryStore(stateDirectory: runtime.state, petID: "white-dragon")
            let identity = try await store.loadIdentity(defaultName: "龙妹")
            let memories = try await store.listMemories()
            let capabilities = CharacterCapabilitySnapshot.make(runtime: runtime,
                                                                  speechRuntimeAvailable: speechRuntime != nil)
            return CharacterContextBuilder.make(identity: identity, memories: memories,
                                                capabilities: capabilities, query: query)
        } catch {
            diagnostics.record("character.context.unavailable")
            return nil
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
        guard let action = sender.representedObject as? PetMenuAction,
              action.instanceID != "white-dragon",
              let multiPet,
              let row = multiPet.instances.first(where: { $0.id == action.instanceID }),
              row.phase == .stopped || row.phase == .failed else { return }
        let alert = NSAlert()
        alert.messageText = "删除这个桌宠实例？"
        alert.informativeText = "将从实例清单中移除“\(PetPresentation.name(id: row.id, displayName: row.displayName))”。必须先停止并完成清理；素材包和独立状态目录会保留。原始龙妹不可删除。"
        alert.addButton(withTitle: "删除实例")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        multiPet.delete(instanceID: row.id)
        rebuildMenu()
    }
    @objc private func togglePause() { _ = handle(.init(paused ? .resume : .pause)) }
    @objc private func quit() { _ = handle(.init(.quit)) }
    @objc private func openWindowPermissionSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else { return }
        NSWorkspace.shared.open(url)
    }
    @objc private func openSettings() { NSWorkspace.shared.open(runtime.state) }
}
