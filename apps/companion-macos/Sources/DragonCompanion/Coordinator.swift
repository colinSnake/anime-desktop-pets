import AppKit
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
        windowSizeRequested = false; reportedWindowReady = false; requestedStartupFrame = nil
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
                if !windowSizeRequested {
                    windowSizeRequested = true
                    let screen = WindowGeometry.screen(for: frame)
                    let visible = screen?.visibleFrame ?? frame
                    let desired = StartupPresentation.videoFrame(near: frame, visible: visible,
                                                                 maximumWidth: runtime.configuration.playerMaxWidth)
                    requestedStartupFrame = desired
                    let result = StartupWindowSizing.request(pid: target.processIdentifier, matching: frame, desired: desired,
                                                           visible: visible, primaryTop: Double(NSScreen.screens.first?.frame.maxY ?? 0))
                    diagnostics.record("codex.window-size result=\(result.rawValue)")
                    if result == .requested {
                        lastFrame = nil; stableFrames = 0
                        return // Read the actual post-resize window before handoff.
                    }
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
    private func play(frame: NSRect?) {
        let id = UUID(); movieID = id
        movie = BootPlayer(config: runtime.configuration, diagnostics: diagnostics,
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
        if let multiPet { multiPet.finishStopping(completion: completion) }
        else { pet.finishWindowCommands(completion: completion) }
    }

    private func createMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem?.button?.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: AppCopy.name)
        statusItem?.button?.toolTip = "\(AppCopy.name) · \(AppCopy.tagline)"
        rebuildMenu()
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
        if mode != .previewAnimation, multiPet == nil, runtime.configuration.petBackend == "external" {
            if let candidate = PetInstanceRuntime(runtime: runtime), candidate.registryIsMissing {
                menu.addItem(.separator())
                if ExternalPetDescriptor.supportsManagedHandoff(runtime) {
                    let create = NSMenuItem(title: firstCloneInProgress ? "正在切换桌宠" : "创建白龙分身",
                                            action: firstCloneInProgress ? nil : #selector(createFirstClone), keyEquivalent: "")
                    create.target = self
                    create.isEnabled = !firstCloneInProgress && !paused && pet.canHandoffToMultiPet
                    if !pet.canHandoffToMultiPet { create.title = "先显示由桌边小崽启动的增强白龙" }
                    menu.addItem(create)
                } else {
                    let unavailable = NSMenuItem(title: "当前白龙构建不支持安全分身切换", action: nil, keyEquivalent: "")
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
        if FileManager.default.isExecutableFile(atPath: runtime.petLibraryAppURL.appendingPathComponent("Contents/MacOS/DragonPetLibrary").path) {
            menu.addItem(.separator())
            item("打开宠物素材库", #selector(openPetLibrary))
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
        let settings = NSMenuItem(title: "打开配置文件夹", action: #selector(openSettings), keyEquivalent: "")
        settings.target = self; advanced.addItem(settings)
        let advancedItem = NSMenuItem(title: "高级", action: nil, keyEquivalent: "")
        advancedItem.submenu = advanced
        menu.addItem(advancedItem)
        menu.addItem(.separator()); item(AppCopy.quitTitle, #selector(quit))
        statusItem?.menu = menu; self.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) { rebuildMenu() }

    private func petManagementMenu() -> NSMenu? {
        guard let multiPet, multiPet.hasValidRegistry else { return nil }
        let menu = NSMenu(title: "实例管理")
        let cloneMenu = NSMenu(title: "创建小分身")
        let allRows = multiPet.instances.sorted { $0.id < $1.id }
        for row in allRows where row.enabled {
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
            let instanceMenu = NSMenu(title: row.id)
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
            let automatic = row.autoStartOnLaunch ? "下次启动恢复" : "下次启动保持停止"
            let error = row.error.map { " · \($0.prefix(48))" } ?? ""
            let instanceItem = NSMenuItem(title: "\(row.id) · \(managedPhaseTitle(row.phase)) · \(automatic)\(error)", action: nil, keyEquivalent: "")
            instanceItem.submenu = instanceMenu
            menu.addItem(instanceItem)
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

    @objc private func createFirstClone() {
        guard !firstCloneInProgress, multiPet == nil,
              let candidate = PetInstanceRuntime(runtime: runtime), candidate.registryIsMissing,
              ExternalPetDescriptor.supportsManagedHandoff(runtime) else { return }
        firstCloneInProgress = true
        rebuildMenu()
        Task { @MainActor [weak self] in
            guard let self else { return }
            let runtime = self.runtime
            let inspected = await Task.detached(priority: .utility) {
                Result { try ExternalPetDescriptor.inspect(runtime) }
            }.value
            guard !self.stopping else { return }
            let descriptor: ExternalPetDescriptor
            switch inspected {
            case .success(let value): descriptor = value
            case .failure(let error):
                self.firstCloneInProgress = false
                self.showError("无法验证当前白龙素材，未进行切换：\(error.localizedDescription)")
                self.rebuildMenu()
                return
            }
            guard let assets = descriptor.assetsURL else {
                self.firstCloneInProgress = false
                self.showError("当前白龙素材身份无法用于分身，未进行切换。")
                self.rebuildMenu()
                return
            }
            let confirmation = NSAlert()
            confirmation.messageText = "切换到白龙实例管理？"
            confirmation.informativeText = "桌边小崽将先请求当前由本宿主启动的白龙安全退出，再由单个多实例控制器恢复原宠并登记一个已停止的分身。取消不会更改状态；若退出未确认，将不会启动第二个控制器。"
            confirmation.alertStyle = .warning
            confirmation.addButton(withTitle: "切换并创建")
            confirmation.addButton(withTitle: "取消")
            guard confirmation.runModal() == .alertFirstButtonReturn else {
                self.firstCloneInProgress = false
                self.rebuildMenu()
                return
            }
            self.pet.handoffToMultiPet { [weak self] result in
                guard let self else { return }
                guard !self.stopping else { return }
                switch result {
                case .failure(let error):
                    self.firstCloneInProgress = false
                    self.showError("\(error.localizedDescription)\n请退出并重新打开桌边小崽；启动时会根据磁盘清单恢复单宠或多宠模式。结果不确定时不要连续重试创建。")
                    self.rebuildMenu()
                case .success(let preferences):
                    guard let manager = PetInstanceRuntime(runtime: self.runtime) else {
                        self.firstCloneInProgress = false
                        self.showError("多实例 helper 不可用；白龙已停止，没有启动竞争控制器。请重新打开桌边小崽后检查构建。")
                        self.rebuildMenu()
                        return
                    }
                    self.configure(manager)
                    self.multiPet = manager
                    manager.createInitialPair(assets: assets, preferences: preferences) { [weak self] result in
                        guard let self else { return }
                        self.firstCloneInProgress = false
                        switch result {
                        case .success:
                            self.showNotice("白龙分身已创建并保持停止。原宠已交由多实例控制器恢复；可在“实例管理”中单独启动分身。")
                        case .failure(let error):
                            self.showError(error.localizedDescription)
                        }
                        self.rebuildMenu()
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
        alert.informativeText = "将从实例清单中移除“\(row.id)”。必须先停止并完成清理；素材包和独立状态目录会保留。原始白龙不可删除。"
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
}
