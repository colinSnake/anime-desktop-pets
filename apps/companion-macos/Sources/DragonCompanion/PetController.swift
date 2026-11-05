import AppKit
import DragonCore
import ImageIO
import QuartzCore

@MainActor
private final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
private final class PetView: NSView {
    let imageView = NSImageView()
    var onClick: (() -> Void)?
    var onDragEnd: (() -> Void)?
    var makeMenu: (() -> NSMenu)?
    private var anchor = NSPoint.zero
    private var origin = NSPoint.zero
    private var dragged = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        imageView.frame = bounds.insetBy(dx: 8, dy: 8)
        imageView.autoresizingMask = [.width, .height]
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.animates = true
        addSubview(imageView)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func hitTest(_ point: NSPoint) -> NSView? {
        // Transparent corners do not consume desktop clicks.
        guard bounds.insetBy(dx: bounds.width * 0.10, dy: bounds.height * 0.05).contains(point) else { return nil }
        return self
    }
    override func mouseDown(with event: NSEvent) {
        anchor = NSEvent.mouseLocation; origin = window?.frame.origin ?? .zero; dragged = false
    }
    override func mouseDragged(with event: NSEvent) {
        let mouse = NSEvent.mouseLocation
        let dx = mouse.x - anchor.x, dy = mouse.y - anchor.y
        if hypot(dx, dy) > 4 { dragged = true }
        guard dragged, let window else { return }
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? window.screen ?? NSScreen.main
        let area = screen?.visibleFrame ?? window.frame
        let p = NSPoint(x: min(max(origin.x + dx, area.minX), max(area.minX, area.maxX - window.frame.width)),
                        y: min(max(origin.y + dy, area.minY), max(area.minY, area.maxY - window.frame.height)))
        window.setFrameOrigin(p)
    }
    override func mouseUp(with event: NSEvent) {
        if dragged { onDragEnd?() } else { onClick?() }
    }
    override func menu(for event: NSEvent) -> NSMenu? { makeMenu?() }
}

@MainActor
private final class ExternalLaunchTicket { var cancelled = false }

@MainActor
final class PetController: NSObject {
    private struct HandoffError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    var taskFollowingAllowed = false
    var onHide: (() -> Void)?
    var onError: ((String) -> Void)?
    private(set) var lastError: String?
    private let runtime: Runtime
    private var panel: PetPanel?
    private var bubble: PetPanel?
    private var bubbleTimer: Timer?
    private var visibilityTimer: Timer?
    private var desiredVisible = false
    private var external: NSRunningApplication?
    private var externalOwned = false
    private var managedExternal: NSRunningApplication?
    private var externalIntent = ExternalPetLaunchIntent()
    private var launchTicket: ExternalLaunchTicket?
    private var externalWindowControl = false
    private var descriptorLoadTask: Task<Void, Never>?
    private var handoffInProgress = false
    private let windowCommandQueue = DispatchQueue(label: "local.dragon.pet-window-control", qos: .utility)
    private var windowCommandWork: DispatchWorkItem?
    var onChanged: (() -> Void)?

    private func requestWindow(_ command: String, app: NSRunningApplication) {
        windowCommandWork?.cancel()
        let pid = app.processIdentifier
        let intent = externalIntent.generation
        let work = DispatchWorkItem { [weak self] in
            let result = Result { try PetWindowControl.send(command, pid: pid) }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.externalIntent.generation == intent else { return }
                switch result {
                case .success: self.lastError = nil
                case .failure(let error): self.failExternal("窗口操作未确认：\(error.localizedDescription)")
                }
                self.onChanged?()
            }
        }
        windowCommandWork = work
        windowCommandQueue.async(execute: work)
    }
    func finishWindowCommands(completion: @escaping @MainActor () -> Void) {
        // AppKit termination runs a nested modal loop; the main dispatch queue
        // may already be inside terminate(). Deliver in the modal run-loop mode.
        windowCommandQueue.async {
            RunLoop.main.perform(inModes: [.default, .modalPanel]) {
                MainActor.assumeIsolated { completion() }
            }
        }
    }

    var isVisible: Bool {
        panel?.isVisible ?? (external.map { !$0.isHidden && !$0.isTerminated && WindowGeometry.hasVisibleWindow(pid: $0.processIdentifier) } ?? false)
    }
    var canHandoffToMultiPet: Bool {
        !handoffInProgress && externalOwned && externalWindowControl &&
            launchTicket == nil && descriptorLoadTask == nil && external?.isTerminated == false
    }
    var state: String {
        if handoffInProgress { return "switching" }
        if lastError != nil { return "failed" }
        if (descriptorLoadTask != nil || launchTicket != nil) && desiredVisible { return "starting" }
        if isVisible { return "visible" }
        if let external, !external.isTerminated { return desiredVisible ? "running-no-visible-window" : "hidden" }
        return desiredVisible ? "not-running" : "idle"
    }

    init(runtime: Runtime) { self.runtime = runtime }

    func show(near frame: NSRect?) {
        guard !handoffInProgress else { return }
        guard runtime.configuration.petEnabled else { return }
        desiredVisible = true; lastError = nil; _ = externalIntent.show(); launchTicket?.cancelled = false
        if runtime.configuration.petBackend == "external" { showExternal(); return }
        if panel == nil { build(near: frame) }
        refreshVisibility()
        if visibilityTimer == nil {
            visibilityTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refreshVisibility() }
            }
        }
    }

    private func build(near frame: NSRect?) {
        let size = runtime.configuration.petSize
        let screen = WindowGeometry.screen(for: frame)
        let area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        var origin = NSPoint(x: area.maxX - size - 28, y: area.minY + 28)
        if let data = try? Data(contentsOf: runtime.state.appendingPathComponent("pet-position.json")),
           let saved = try? JSONDecoder().decode([String: Double].self, from: data),
           let x = saved["x"], let y = saved["y"], x.isFinite, y.isFinite {
            let point = NSPoint(x: x, y: y)
            let savedScreen = NSScreen.screens.first { $0.visibleFrame.contains(point) }
            if let available = savedScreen?.visibleFrame {
                origin = NSPoint(x: min(max(x, available.minX), max(available.minX, available.maxX - size)),
                                 y: min(max(y, available.minY), max(available.minY, available.maxY - size)))
            }
        }
        let panel = PetPanel(contentRect: NSRect(origin: origin, size: NSSize(width: size, height: size)), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Dragon · 桌宠"
        panel.isReleasedWhenClosed = false; panel.isOpaque = false; panel.backgroundColor = .clear
        panel.hasShadow = false; panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false; panel.isFloatingPanel = true
        let view = PetView(frame: NSRect(origin: .zero, size: panel.frame.size))
        view.imageView.image = validatedImage(at: runtime.petURL) ?? NSImage(systemSymbolName: "sparkles", accessibilityDescription: "桌宠素材未导入")
        view.onClick = { [weak self] in self?.say(["我在这里陪你。", "慢慢来，把想法变成作品。", "可以拖动我，右键打开菜单。", "静态预览模式；完整动画请使用增强桌宠。"].randomElement()!) }
        view.onDragEnd = { [weak self] in self?.savePosition() }
        view.makeMenu = { [weak self] in self?.menu() ?? NSMenu() }
        panel.contentView = view; self.panel = panel
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            view.imageView.wantsLayer = true
            let breath = CABasicAnimation(keyPath: "transform.translation.y")
            breath.fromValue = 0; breath.toValue = 4; breath.duration = 1.8
            breath.autoreverses = true; breath.repeatCount = .infinity
            breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            view.imageView.layer?.add(breath, forKey: "idle-breath")
        }
    }

    private func validatedImage(at url: URL) -> NSImage? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              (attrs[.size] as? NSNumber)?.intValue ?? Int.max <= 32 * 1024 * 1024,
              let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) <= 240,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.intValue > 0, height.intValue > 0,
              width.intValue <= 2048, height.intValue <= 2048,
              width.intValue * height.intValue * 4 * CGImageSourceGetCount(source) <= 128 * 1024 * 1024 else { return nil }
        return NSImage(contentsOf: url)
    }

    private func refreshVisibility() {
        guard let panel else { return }
        let fullscreen = runtime.configuration.hidePetInFullscreen && WindowGeometry.screen(for: panel.frame).map { WindowGeometry.fullscreenOtherApp(on: $0) } == true
        if desiredVisible && !fullscreen {
            if !panel.isVisible { panel.orderFrontRegardless() }
        } else { panel.orderOut(nil); bubble?.orderOut(nil) }
    }
    func hide() {
        guard !handoffInProgress else { return }
        externalIntent.hide(); launchTicket?.cancelled = true; desiredVisible = false
        visibilityTimer?.invalidate(); visibilityTimer = nil
        panel?.orderOut(nil); bubble?.orderOut(nil)
        if let external {
            if externalWindowControl { requestWindow("hide", app: external) }
            else if !external.hide() { failExternal("此桌宠版本不支持宿主隐藏，请使用桌宠右键菜单") }
        }
    }
    func dismiss(preserveIndependentExternal: Bool = false) {
        if handoffInProgress {
            desiredVisible = false
            visibilityTimer?.invalidate(); visibilityTimer = nil
            return
        }
        if preserveIndependentExternal {
            externalIntent.hide(); launchTicket?.cancelled = true; desiredVisible = false
            if externalOwned, externalWindowControl, let external { requestWindow("quit", app: external) }
            else if externalOwned { _ = external?.hide() }
            // Independent helpers belong to their user, not this coordinator.
            external = nil
        } else { hide() }
        visibilityTimer?.invalidate(); visibilityTimer = nil
        bubbleTimer?.invalidate(); bubbleTimer = nil; bubble?.close(); bubble = nil
        panel?.close(); panel = nil
        // Never terminate a third-party app: it may own a running Codex task.
        external = nil; externalOwned = false
    }

    func handoffToMultiPet(completion: @escaping @MainActor (Result<PetInstancePreferences, Error>) -> Void) {
        guard !handoffInProgress, let app = external, !app.isTerminated,
              externalOwned, externalWindowControl, launchTicket == nil, descriptorLoadTask == nil else {
            completion(.failure(HandoffError(message: "当前白龙不是由本宿主启动的受控增强版。请从白龙自身菜单退出后重试；不会自动关闭其他进程。")))
            return
        }
        handoffInProgress = true
        let pid = app.processIdentifier
        windowCommandQueue.async { [weak self, weak app] in
            let result = Result { () throws -> PetInstancePreferences in
                let status = try PetWindowControl.send("status", pid: pid)
                guard status.preferences != nil else {
                    throw HandoffError(message: "当前增强桌宠没有报告可迁移的偏好；为避免丢失设置，未请求退出。")
                }
                let quit = try PetWindowControl.send("quit", pid: pid)
                guard let preferences = quit.preferences else {
                    throw HandoffError(message: "白龙退出确认未包含偏好；退出结果不确定，没有启动多宠控制器。")
                }
                return preferences
            }
            Task { @MainActor [weak self, weak app] in
                guard let self else { return }
                guard case .success(let reply) = result else {
                    self.handoffInProgress = false
                    if case .failure(let error) = result { completion(.failure(error)) }
                    self.onChanged?()
                    return
                }
                do {
                    try reply.validate()
                    for _ in 0..<60 {
                        if app?.isTerminated != false { break }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    guard app?.isTerminated != false else {
                        throw HandoffError(message: "白龙已确认退出请求，但进程仍未退出；为避免双重渲染，没有启动多宠控制器。请确认白龙已关闭后重新尝试。")
                    }
                    self.external = nil
                    self.managedExternal = nil
                    self.externalOwned = false
                    self.desiredVisible = false
                    self.visibilityTimer?.invalidate(); self.visibilityTimer = nil
                    self.bubbleTimer?.invalidate(); self.bubbleTimer = nil
                    self.bubble?.close(); self.bubble = nil
                    self.panel?.close(); self.panel = nil
                    self.handoffInProgress = false
                    self.onChanged?()
                    completion(.success(reply))
                } catch {
                    self.handoffInProgress = false
                    self.onChanged?()
                    completion(.failure(error))
                }
            }
        }
    }
    private func showExternal() {
        guard descriptorLoadTask == nil else { return }
        let runtime = self.runtime
        descriptorLoadTask = Task { @MainActor [weak self] in
            let result = await Task.detached(priority: .utility) {
                Result { try ExternalPetDescriptor.inspect(runtime) }
            }.value
            guard let self else { return }
            self.descriptorLoadTask = nil
            guard self.desiredVisible else { return }
            switch result {
            case .success(let descriptor): self.launchExternal(descriptor)
            case .failure(let error): self.failExternal(error.localizedDescription); self.onChanged?()
            }
        }
    }

    private func launchExternal(_ descriptor: ExternalPetDescriptor) {
        externalWindowControl = descriptor.supportsWindowControl
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: descriptor.bundleIdentifier).first(where: { !$0.isTerminated }) {
            if descriptor.catalog != nil,
               app.bundleURL.flatMap({ Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleVersion") as? String }) != descriptor.buildVersion {
                failExternal("已有不同版本的白龙桌宠在运行；请手动退出它后重试，不会自动强退")
                return
            }
            if descriptor.catalog != nil, let launched = app.launchDate,
               let executable = app.executableURL,
               let modified = try? executable.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
               modified > launched {
                failExternal("桌宠构建已更新，当前进程仍是旧版本；请从桌宠菜单退出后重试，不会自动强退")
                return
            }
            external = app
            externalOwned = managedExternal?.processIdentifier == app.processIdentifier && managedExternal?.isTerminated == false
            if externalWindowControl { requestWindow("show", app: app); return }
            _ = app.unhide()
            if descriptor.catalog != nil {
                // 上游手动隐藏不会被 NSRunningApplication.unhide 清除；连接其固定的唤回 Socket。
                _ = LocalPetReveal.connect(at: FileManager.default.temporaryDirectory.appendingPathComponent("bailong-desktop-pet-v1"))
            }
            return
        }
        guard launchTicket == nil else { return }
        let token = externalIntent.generation
        let ticket = ExternalLaunchTicket(); launchTicket = ticket
        let options = NSWorkspace.OpenConfiguration()
        options.activates = false; options.createsNewApplicationInstance = false
        if let assetsURL = descriptor.assetsURL {
            options.environment = ProcessInfo.processInfo.environment.merging(["BAILONG_ASSETS_DIR": assetsURL.path]) { _, new in new }
        }
        options.environment = ProcessInfo.processInfo.environment.merging(options.environment) { _, new in new }.merging(
            ["DRAGON_TASK_LEASE": taskFollowingAllowed ? runtime.state.appendingPathComponent("codex-task-lease.json").path : "",
             "DRAGON_WINDOW_CONTROL": descriptor.supportsWindowControl ? "1" : "0"]) { _, new in new }
        // 不传自动启动、查询或聊天参数；仅启动上游完整桌宠。
        NSWorkspace.shared.openApplication(at: descriptor.url, configuration: options) { [weak self, ticket] app, error in
            Task { @MainActor [weak self] in
                guard let self else {
                    if ticket.cancelled { _ = app?.hide() }
                    return
                }
                guard self.launchTicket === ticket else { return }
                self.launchTicket = nil
                guard let app else {
                    if self.desiredVisible { self.failExternal(error?.localizedDescription ?? "完整桌宠启动失败，请检查系统安全提示和应用路径") }
                    return
                }
                self.external = app; self.managedExternal = app; self.externalOwned = true
                switch self.externalIntent.resolve(token) {
                case .hide:
                    if self.externalWindowControl { self.requestWindow("hide", app: app) }
                    else { _ = app.hide() }
                case .reveal, .leaveAlone:
                    // 旧请求不能把更新的显示意图隐藏掉；也不抢键盘焦点。
                    if self.desiredVisible { _ = app.unhide() }
                }
                self.onChanged?()
            }
        }
    }
    private func failExternal(_ message: String) {
        lastError = message; onError?(message)
    }
    private func savePosition() {
        guard let origin = panel?.frame.origin else { return }
        if let data = try? JSONEncoder().encode(["x": origin.x, "y": origin.y]) {
            try? data.write(to: runtime.state.appendingPathComponent("pet-position.json"), options: .atomic)
        }
    }
    private func say(_ text: String) {
        guard let panel, panel.isVisible else { return }
        bubbleTimer?.invalidate(); bubble?.close()
        let area = panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? panel.frame
        let width = min(300.0, max(120.0, area.width - 24))
        let textWidth = width - 24
        let font = NSFont.systemFont(ofSize: 12)
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byCharWrapping
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
        let measured = (text as NSString).boundingRect(with: NSSize(width: textWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes)
        let contentHeight = max(24, ceil(measured.height) + 8)
        let visibleHeight = min(contentHeight, max(40, min(300, area.height - 44)))
        let size = NSSize(width: width, height: visibleHeight + 20)
        let scroll = NSScrollView(frame: NSRect(x: 12, y: 10, width: textWidth, height: visibleHeight))
        scroll.drawsBackground = false; scroll.hasVerticalScroller = contentHeight > visibleHeight; scroll.autohidesScrollers = true
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: textWidth, height: contentHeight))
        textView.isEditable = false; textView.isSelectable = true; textView.drawsBackground = false
        textView.textContainerInset = .zero; textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.containerSize = NSSize(width: textWidth, height: .greatestFiniteMagnitude)
        textView.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: attributes))
        scroll.documentView = textView
        let bubble = PetPanel(contentRect: NSRect(origin: NSPoint(x: panel.frame.midX - width / 2, y: panel.frame.maxY + 6), size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        bubble.isReleasedWhenClosed = false; bubble.isOpaque = false; bubble.backgroundColor = .clear
        bubble.level = .floating; bubble.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let root = NSView(frame: NSRect(origin: .zero, size: size)); root.wantsLayer = true
        root.layer?.cornerRadius = 14; root.layer?.backgroundColor = NSColor(calibratedRed: 0.96, green: 0.94, blue: 0.99, alpha: 0.98).cgColor
        root.addSubview(scroll); bubble.contentView = root
        if let area = panel.screen?.visibleFrame {
            var rect = bubble.frame
            rect.origin.x = min(max(rect.minX, area.minX), area.maxX - rect.width)
            if rect.maxY > area.maxY { rect.origin.y = panel.frame.minY - rect.height - 6 }
            rect.origin.y = max(area.minY, rect.minY); bubble.setFrame(rect, display: false)
        }
        self.bubble = bubble; bubble.orderFrontRegardless()
        bubbleTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.bubble?.orderOut(nil) }
        }
    }
    private func menu() -> NSMenu {
        let menu = NSMenu()
        let title = NSMenuItem(title: AppCopy.name, action: nil, keyEquivalent: ""); title.isEnabled = false; menu.addItem(title)
        menu.addItem(.separator())
        let hide = NSMenuItem(title: "隐藏桌宠", action: #selector(hideAction), keyEquivalent: ""); hide.target = self; menu.addItem(hide)
        return menu
    }
    @objc private func hideAction() { onHide?() }
}
