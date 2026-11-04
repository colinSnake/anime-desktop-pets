import AppKit
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
final class Coordinator: NSObject {
    enum Mode: Equatable { case launch, watch, previewAnimation, previewPet, controlTest }
    private let runtime: Runtime
    private let mode: Mode
    private let diagnostics: Diagnostics
    private var session = LaunchSession()
    private var target: NSRunningApplication?
    private var pet: PetController
    private var multiPet: PetInstanceRuntime?
    private var movie: BootPlayer?
    private var movieID: UUID?
    private var launchRequestID: UUID?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var poll: Timer?
    private var taskLeaseTimer: Timer?
    private var pendingSince = 0.0
    private var lastFrame: NSRect?
    private var stableFrames = 0
    private var statusItem: NSStatusItem?
    private var menu: NSMenu?
    private(set) var paused = false

    init(runtime: Runtime, mode: Mode) {
        self.runtime = runtime; self.mode = mode
        diagnostics = Diagnostics(root: runtime.state); pet = PetController(runtime: runtime)
        multiPet = PetInstanceRuntime(runtime: runtime)
        super.init()
        pet.taskFollowingAllowed = mode == .watch || mode == .launch
        multiPet?.taskFollowingAllowed = mode == .watch || mode == .launch
        pet.onError = { [weak self] message in self?.diagnostics.record("pet.error \(message)") }
        pet.onHide = { [weak self] in _ = self?.handle(.init(.hide)) }
        pet.onDismiss = { [weak self] in _ = self?.handle(.init(.dismiss)) }
        multiPet?.onChanged = { [weak self] in
            let state = self?.multiPet?.state ?? "unknown"
            self?.diagnostics.record("multi-pet.changed state=\(state)")
            self?.rebuildMenu()
        }
    }

    func start() {
        diagnostics.record("controller.start mode=\(mode)")
        guard mode != .controlTest else { return }
        createMenu()
        if multiPet != nil, mode != .previewAnimation { multiPet?.start() }
        if mode == .previewPet { showPetRuntime(near: nil); return }
        if mode == .previewAnimation {
            play(frame: nil, ready: { true }); return
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
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollWindow() }
        }
        if movie == nil {
            session.startAnimation(pid: app.processIdentifier)
            play(frame: nil, ready: { [weak self] in self?.startupWindowReady ?? false })
        }
        pollWindow()
    }
    private var startupWindowReady: Bool {
        guard let target, !target.isTerminated, target.isFinishedLaunching, stableFrames >= 2 else { return false }
        // A stable visible window is only a handoff signal, not proof that network/UI loading finished.
        return WindowGeometry.codexWindow(pid: target.processIdentifier) != nil
    }
    private func pollWindow() {
        guard !paused, let target, !target.isTerminated else { poll?.invalidate(); poll = nil; return }
        if let frame = WindowGeometry.codexWindow(pid: target.processIdentifier) {
            stableFrames = frame == lastFrame ? stableFrames + 1 : 1; lastFrame = frame
            if stableFrames >= 2 {
                movie?.match(frame: frame)
                if target.isFinishedLaunching {
                    poll?.invalidate(); poll = nil
                    diagnostics.record("codex.window-ready")
                    return
                }
            }
        } else {
            stableFrames = 0; lastFrame = nil
        }
        if ProcessInfo.processInfo.systemUptime - pendingSince > runtime.configuration.windowWaitTimeout {
            poll?.invalidate(); poll = nil
            diagnostics.record("animation.timed-out no-visible-window")
            movie?.finish(.timedOut)
        }
    }
    private func play(frame: NSRect?, ready: @escaping () -> Bool) {
        let id = UUID(); movieID = id
        movie = BootPlayer(config: runtime.configuration, diagnostics: diagnostics, ready: ready,
                           preservesTargetActivation: mode != .previewAnimation) { [weak self] outcome in
            guard let self, self.movieID == id else { return }
            self.movieID = nil; self.movie = nil
            self.poll?.invalidate(); self.poll = nil
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
                play(frame: nil, ready: { [weak self] in self?.startupWindowReady ?? false })
            }
            let options = NSWorkspace.OpenConfiguration(); options.activates = true; options.createsNewApplicationInstance = false
            diagnostics.record("codex.launch-requested")
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
        } catch { showError(error.localizedDescription) }
    }
    private func showError(_ text: String) {
        let alert = NSAlert(); alert.messageText = AppCopy.name; alert.informativeText = text
        alert.addButton(withTitle: "好"); alert.runModal()
    }

    private func showPetRuntime(near frame: NSRect?) {
        if let multiPet {
            multiPet.show()
        } else {
            pet.show(near: frame)
        }
    }

    private func hidePetRuntime() {
        if let multiPet { multiPet.hide() } else { pet.hide() }
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
            if !paused && (mode == .previewPet || (session.pid != nil && session.phase == .accompanying)) { showPetRuntime(near: lastFrame) }
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
        taskLeaseTimer?.invalidate(); taskLeaseTimer = nil
        refreshTaskLease(disabled: true)
        paused = true
        launchRequestID = nil; session.cancelPendingLaunch()
        poll?.invalidate(); poll = nil; movie?.finish(.targetExited, immediate: true); movie = nil
        dismissPetRuntime()
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll(); diagnostics.record("controller.stop")
    }
    private func createMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem?.button?.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: AppCopy.name)
        statusItem?.button?.toolTip = "\(AppCopy.name) · \(AppCopy.tagline)"
        rebuildMenu()
    }
    private func rebuildMenu() {
        guard statusItem != nil else { return }
        let menu = NSMenu()
        let backendLabel = runtime.configuration.petBackend == "external" ? "动画桌宠" : "静态预览"
        let label = NSMenuItem(title: "\(AppCopy.name) · \(paused ? "已暂停" : backendLabel)", action: nil, keyEquivalent: "")
        label.isEnabled = false; menu.addItem(label); menu.addItem(.separator())
        func item(_ title: String, _ selector: Selector) { let i = NSMenuItem(title: title, action: selector, keyEquivalent: ""); i.target = self; menu.addItem(i) }
        item("显示桌宠", #selector(showPet)); item("隐藏桌宠", #selector(hidePet)); item("结束本次桌宠", #selector(dismissPet))
        if let management = petManagementMenu() {
            let managementItem = NSMenuItem(title: "宠物管理", action: nil, keyEquivalent: "")
            managementItem.submenu = management
            menu.addItem(managementItem)
        }
        if FileManager.default.isExecutableFile(atPath: runtime.petLibraryAppURL.appendingPathComponent("Contents/MacOS/DragonPetLibrary").path) {
            menu.addItem(.separator())
            item("打开宠物素材库…", #selector(openPetLibrary))
        }
        menu.addItem(.separator()); item(paused ? "恢复联动" : "暂停联动", #selector(togglePause))
        item("打开 Codex", #selector(openCodex)); item("打开配置目录", #selector(openSettings))
        menu.addItem(.separator()); item(AppCopy.quitTitle, #selector(quit))
        statusItem?.menu = menu; self.menu = menu
    }

    private func petManagementMenu() -> NSMenu? {
        guard let multiPet, multiPet.isConfigured else { return nil }
        let menu = NSMenu(title: "宠物管理")
        func item(_ title: String, _ selector: Selector, action: PetMenuAction? = nil,
                  state: NSControl.StateValue = .off, enabled: Bool = true) {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
            entry.target = self; entry.representedObject = action
            entry.state = state; entry.isEnabled = enabled; menu.addItem(entry)
        }
        item("全部显示", #selector(showManagedPets))
        item("全部隐藏", #selector(hideManagedPets))
        let cloneMenu = NSMenu(title: "创建小分身")
        let allRows = multiPet.instances.sorted { $0.id < $1.id }
        for row in allRows {
            let cloneItem = NSMenuItem(title: "从 \(row.id) 创建", action: #selector(cloneManagedPet), keyEquivalent: "")
            cloneItem.target = self
            cloneItem.representedObject = PetMenuAction(instanceID: row.id, cloneSourceID: row.id)
            cloneMenu.addItem(cloneItem)
        }
        let cloneEntry = NSMenuItem(title: "创建小分身", action: nil, keyEquivalent: "")
        cloneEntry.submenu = cloneMenu
        cloneEntry.isEnabled = !allRows.isEmpty && allRows.count < 32
        menu.addItem(cloneEntry)
        menu.addItem(.separator())

        let rows = multiPet.instances.filter(\.enabled).sorted { $0.id < $1.id }
        if rows.isEmpty {
            let empty = NSMenuItem(title: "没有启用的宠物", action: nil, keyEquivalent: "")
            empty.isEnabled = false; menu.addItem(empty)
            return menu
        }
        for row in rows {
            let action = PetMenuAction(instanceID: row.id)
            let running = row.phase == .running || row.phase == .starting
            let title = "\(row.id) · \(managedPhaseTitle(row.phase))"
            item(running ? "隐藏 \(title)" : "显示 \(title)", #selector(toggleManagedPet), action: action,
                 enabled: row.phase != .stopping)

            let sizeMenu = NSMenu(title: "\(row.id) 尺寸")
            for size in [128, 192, 256, 320, 384] {
                let sizeItem = NSMenuItem(title: "\(size) × \(size)", action: #selector(setManagedPetSize), keyEquivalent: "")
                sizeItem.target = self
                sizeItem.representedObject = PetMenuAction(instanceID: row.id, size: size)
                sizeItem.state = row.preferences.size == size ? .on : .off
                sizeMenu.addItem(sizeItem)
            }
            let sizeItem = NSMenuItem(title: "调整尺寸…", action: nil, keyEquivalent: "")
            sizeItem.submenu = sizeMenu
            menu.addItem(sizeItem)
        }
        return menu
    }

    private func managedPhaseTitle(_ phase: PetInstancePhase) -> String {
        switch phase {
        case .stopped: return "已停止"
        case .starting: return "启动中"
        case .running: return "运行中"
        case .stopping: return "停止中"
        case .failed: return "异常"
        }
    }

    @objc private func showPet() { _ = handle(.init(.show)) }
    @objc private func hidePet() { _ = handle(.init(.hide)) }
    @objc private func dismissPet() { _ = handle(.init(.dismiss)) }
    @objc private func showManagedPets() { multiPet?.show(); rebuildMenu() }
    @objc private func hideManagedPets() { multiPet?.hide(); rebuildMenu() }
    @objc private func cloneManagedPet(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? PetMenuAction,
              let sourceID = action.cloneSourceID else { return }
        multiPet?.clone(sourceID: sourceID)
        rebuildMenu()
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
    @objc private func togglePause() { _ = handle(.init(paused ? .resume : .pause)) }
    @objc private func quit() { _ = handle(.init(.quit)) }
    @objc private func openSettings() { NSWorkspace.shared.open(runtime.state) }
    @objc private func openPetLibrary() {
        let appURL = runtime.petLibraryAppURL
        guard FileManager.default.isExecutableFile(atPath: appURL.appendingPathComponent("Contents/MacOS/DragonPetLibrary").path) else {
            showPetLibraryError("这个版本还没有素材库窗口，请重新构建\(AppCopy.name) App。")
            return
        }
        do {
            try FileManager.default.createDirectory(at: runtime.petLibraryURL, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            showPetLibraryError("无法创建本地素材库目录：\(error.localizedDescription)")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = [runtime.petLibraryURL.path, runtime.state.appendingPathComponent("pet-instances.json").path,
                                    runtime.state.path]
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { [weak self] _, error in
            guard let error else { return }
            Task { @MainActor in self?.showPetLibraryError("无法打开素材库窗口：\(error.localizedDescription)") }
        }
    }
    private func showPetLibraryError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "宠物素材库无法打开"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
    @objc private func openCodex() { launchCodex() }
}
