import AppKit
import AVKit
import DragonCore

@MainActor
private final class MovieWindow: NSPanel {
    var onSkip: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 || (event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == ".") { onSkip?() }
        else { super.keyDown(with: event) }
    }
}

@MainActor
final class BootPlayer: NSObject {
    enum Outcome: String { case completed, skipped, mediaFailed, timedOut, targetExited }
    private let config: CompanionConfiguration
    private let diagnostics: Diagnostics
    private let targetReady: () -> Bool
    private let preservesTargetActivation: Bool
    private var followsTargetWindow = false
    private let onFinish: (Outcome) -> Void
    private var window: MovieWindow?
    private var player: AVPlayer?
    private var timer: Timer?
    private var status: NSKeyValueObservation?
    private var ended: NSObjectProtocol?
    private var began = ProcessInfo.processInfo.systemUptime
    private var watchdog = PlaybackWatchdog()
    private var finishing = false
    private var waiting = false
    private var waitingLabel: NSTextField?

    init(config: CompanionConfiguration, diagnostics: Diagnostics, ready: @escaping () -> Bool, preservesTargetActivation: Bool = false, onFinish: @escaping (Outcome) -> Void) {
        self.config = config; self.diagnostics = diagnostics; self.targetReady = ready; self.onFinish = onFinish
        self.preservesTargetActivation = preservesTargetActivation
    }

    func start(url: URL, matching frame: NSRect?) {
        began = ProcessInfo.processInfo.systemUptime
        guard FileManager.default.fileExists(atPath: url.path) else { finish(.mediaFailed); return }
        let screen = WindowGeometry.screen(for: frame)
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let width = min(config.playerMaxWidth, visible.width * 0.9, visible.height * 0.9 * 16 / 9)
        let fallback = NSRect(x: visible.midX - width / 2, y: visible.midY - width * 9 / 32, width: width, height: width * 9 / 16)
        let rect = frame ?? fallback
        let style: NSWindow.StyleMask = preservesTargetActivation ? [.borderless, .nonactivatingPanel] : [.borderless]
        let movie = MovieWindow(contentRect: rect, styleMask: style, backing: .buffered, defer: false)
        movie.hidesOnDeactivate = false
        movie.becomesKeyOnlyIfNeeded = true
        followsTargetWindow = frame != nil
        movie.title = "Dragon · 启动动画"
        movie.isReleasedWhenClosed = false; movie.isOpaque = false; movie.backgroundColor = .clear
        movie.level = .floating; movie.hasShadow = true
        movie.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        movie.onSkip = { [weak self] in self?.finish(.skipped) }
        let root = NSView(frame: NSRect(origin: .zero, size: rect.size))
        root.wantsLayer = true; root.layer?.cornerRadius = 12; root.layer?.masksToBounds = true
        root.layer?.backgroundColor = NSColor.black.cgColor
        let video = AVPlayerView(frame: root.bounds)
        video.autoresizingMask = [.width, .height]; video.controlsStyle = .none
        video.videoGravity = .resizeAspect
        root.addSubview(video)
        let button = NSButton(title: preservesTargetActivation ? "跳过" : "跳过  Esc", target: self, action: #selector(skip))
        button.bezelStyle = .rounded; button.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(button)
        let label = NSTextField(labelWithString: "正在等待 Codex 主窗口…")
        label.textColor = .white; label.font = .systemFont(ofSize: 13); label.isHidden = true
        label.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(label); waitingLabel = label
        NSLayoutConstraint.activate([
            button.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16), button.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            label.centerXAnchor.constraint(equalTo: root.centerXAnchor), label.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -24)
        ])
        movie.contentView = root; window = movie
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item); player.volume = Float(config.volume)
        self.player = player; video.player = player
        status = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            Task { @MainActor [weak self] in
                guard let self, !self.finishing else { return }
                if item.status == .readyToPlay { self.player?.play() }
                if item.status == .failed { self.finish(.mediaFailed) }
            }
        }
        ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.finish(.completed) }
        }
        if preservesTargetActivation {
            // Keep the real client active and able to initialize its foreground UI.
            movie.orderFrontRegardless()
        } else {
            movie.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        diagnostics.record("animation.start")
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func match(frame: NSRect) {
        guard !finishing, !followsTargetWindow else { return }
        followsTargetWindow = true
        window?.setFrame(frame, display: true)
    }

    @objc private func skip() { finish(.skipped) }
    private func tick() {
        guard !finishing, let player else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let elapsed = now - began
        if elapsed > config.launchTimeout { finish(.timedOut); return }
        if elapsed > 8 && player.currentItem?.status != .readyToPlay { finish(.mediaFailed); return }
        let t = player.currentTime().seconds
        let ready = targetReady()
        if t >= config.holdAt && !ready {
            if !waiting { waiting = true; player.pause(); waitingLabel?.isHidden = false }
        } else if waiting && ready { waiting = false; waitingLabel?.isHidden = true; player.play() }
        if !waiting { window?.alphaValue = config.opacity(at: t) }
        if t >= config.transitionEnd && ready { finish(.completed); return }
        if watchdog.stalled(position: t, now: now, intentionallyPaused: waiting) { finish(.mediaFailed) }
    }

    func finish(_ outcome: Outcome, immediate: Bool = false) {
        guard !finishing else { return }
        finishing = true; timer?.invalidate(); timer = nil; player?.pause(); status = nil
        if let ended { NotificationCenter.default.removeObserver(ended) }; ended = nil
        let complete: @MainActor @Sendable () -> Void = { [weak self] in
            guard let self else { return }
            self.window?.orderOut(nil); self.window?.close(); self.window = nil; self.player = nil
            self.diagnostics.record("animation.finish \(outcome.rawValue)")
            self.onFinish(outcome)
        }
        if immediate || window == nil { complete(); return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = outcome == .completed ? 0.08 : 0.18
            self.window?.animator().alphaValue = 0
        }, completionHandler: { Task { @MainActor in complete() } })
    }
}
