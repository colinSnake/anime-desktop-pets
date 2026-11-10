import AppKit

@MainActor
final class CompanionWorkspaceWindow: NSWindowController, NSWindowDelegate {
    enum Section: String, CaseIterable {
        case models = "模型管理"
        case speech = "直播语音"
        case character = "角色与记忆"

        var symbol: String {
            switch self {
            case .models: "cpu"
            case .speech: "waveform"
            case .character: "sparkles"
            }
        }

        var subtitle: String {
            switch self {
            case .models: "在线模型与连接"
            case .speech: "输入、声音与回复"
            case .character: "身份、记忆与对话"
            }
        }
    }

    private let modules: [Section: NSViewController]
    private let containerController = NSViewController()
    private let sidebar = NSView()
    private let contentHost = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private var selected: Section = .models
    private var currentController: NSViewController?
    private let speechController: SpeechSettingsWindow

    init(models: ModelManagerWindow, speech: SpeechSettingsWindow, character: NSViewController,
         initialSection: Section = .models) {
        self.modules = [.models: models, .speech: speech, .character: character]
        speechController = speech
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = AppCopy.name
        window.minSize = NSSize(width: 900, height: 620)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.contentViewController = containerController
        window.delegate = self
        buildWindow()
        select(initialSection)
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    func open(_ section: Section) {
        select(section)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        speechController.stopForWindowClose()
    }

    private func buildWindow() {
        guard let content = window?.contentView else { return }
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        sidebar.wantsLayer = true
        sidebar.layer?.backgroundColor = NSColor(calibratedRed: 0.075, green: 0.09, blue: 0.13, alpha: 1).cgColor
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        contentHost.translatesAutoresizingMaskIntoConstraints = false

        let brandMark = NSImageView(image: NSImage(systemSymbolName: "sparkle", accessibilityDescription: nil)!)
        brandMark.contentTintColor = NSColor(calibratedRed: 0.45, green: 0.9, blue: 0.86, alpha: 1)
        brandMark.imageScaling = .scaleProportionallyUpOrDown
        brandMark.translatesAutoresizingMaskIntoConstraints = false
        let brand = NSTextField(labelWithString: AppCopy.name)
        brand.font = .systemFont(ofSize: 17, weight: .semibold)
        brand.textColor = .white
        let tagline = NSTextField(labelWithString: "COMPANION CONSOLE")
        tagline.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
        tagline.textColor = NSColor(calibratedWhite: 0.62, alpha: 1)
        let brandStack = NSStackView(views: [brand, tagline])
        brandStack.orientation = .vertical
        brandStack.alignment = .leading
        brandStack.spacing = 3
        brandStack.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(brandMark)
        sidebar.addSubview(brandStack)

        let sectionLabel = NSTextField(labelWithString: "工作区")
        sectionLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        sectionLabel.textColor = NSColor(calibratedWhite: 0.57, alpha: 1)
        sectionLabel.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(sectionLabel)
        for (index, section) in Section.allCases.enumerated() {
            let button = NSButton(title: "", target: self, action: #selector(selectSection(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(section.rawValue)
            button.setAccessibilityLabel(section.rawValue)
            button.toolTip = section.subtitle
            button.tag = index
            button.isBordered = false
            button.alignment = .left
            button.wantsLayer = true
            button.layer?.cornerRadius = 7
            button.translatesAutoresizingMaskIntoConstraints = false
            let icon = NSImageView(image: NSImage(systemSymbolName: section.symbol, accessibilityDescription: section.rawValue)!)
            icon.contentTintColor = NSColor(calibratedWhite: 0.78, alpha: 1)
            icon.translatesAutoresizingMaskIntoConstraints = false
            let label = NSTextField(labelWithString: section.rawValue)
            label.font = .systemFont(ofSize: 13, weight: .medium)
            label.textColor = NSColor(calibratedWhite: 0.92, alpha: 1)
            label.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(icon)
            button.addSubview(label)
            sidebar.addSubview(button)
            NSLayoutConstraint.activate([
                button.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 14),
                button.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -14),
                button.topAnchor.constraint(equalTo: sectionLabel.bottomAnchor, constant: 12 + CGFloat(index) * 46),
                button.heightAnchor.constraint(equalToConstant: 40),
                icon.leadingAnchor.constraint(equalTo: button.leadingAnchor, constant: 12),
                icon.centerYAnchor.constraint(equalTo: button.centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: 17), icon.heightAnchor.constraint(equalToConstant: 17),
                label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 11),
                label.centerYAnchor.constraint(equalTo: button.centerYAnchor),
            ])
        }

        let footer = NSTextField(wrappingLabelWithString: AppCopy.tagline)
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = NSColor(calibratedWhite: 0.62, alpha: 1)
        footer.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(footer)
        titleLabel.font = .systemFont(ofSize: 23, weight: .semibold)
        subtitleLabel.font = .systemFont(ofSize: 12)
        subtitleLabel.textColor = .secondaryLabelColor
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        contentHost.wantsLayer = true

        content.addSubview(sidebar)
        content.addSubview(titleLabel)
        content.addSubview(subtitleLabel)
        content.addSubview(contentHost)
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            sidebar.topAnchor.constraint(equalTo: content.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: 228),
            brandMark.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 18),
            brandMark.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 28),
            brandMark.widthAnchor.constraint(equalToConstant: 26), brandMark.heightAnchor.constraint(equalToConstant: 26),
            brandStack.leadingAnchor.constraint(equalTo: brandMark.trailingAnchor, constant: 11),
            brandStack.centerYAnchor.constraint(equalTo: brandMark.centerYAnchor),
            sectionLabel.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 18),
            sectionLabel.topAnchor.constraint(equalTo: brandStack.bottomAnchor, constant: 36),
            footer.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 18),
            footer.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -18),
            footer.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -22),
            titleLabel.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: 34),
            titleLabel.topAnchor.constraint(equalTo: content.topAnchor, constant: 26),
            subtitleLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 4),
            contentHost.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            contentHost.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),
            contentHost.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 20),
            contentHost.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -26),
        ])
    }

    @objc private func selectSection(_ sender: NSButton) {
        guard Section.allCases.indices.contains(sender.tag) else { return }
        select(Section.allCases[sender.tag])
    }

    private func select(_ section: Section) {
        selected = section
        titleLabel.stringValue = section.rawValue
        subtitleLabel.stringValue = section.subtitle
        for button in sidebar.subviews.compactMap({ $0 as? NSButton }) {
            let active = button.tag == Section.allCases.firstIndex(of: section)
            button.layer?.backgroundColor = active
                ? NSColor(calibratedRed: 0.12, green: 0.34, blue: 0.38, alpha: 1).cgColor
                : NSColor.clear.cgColor
        }
        if let currentController {
            currentController.view.removeFromSuperview()
            currentController.removeFromParent()
        }
        guard let controller = modules[section] else { return }
        containerController.addChild(controller)
        currentController = controller
        let moduleView = controller.view
        moduleView.translatesAutoresizingMaskIntoConstraints = false
        contentHost.addSubview(moduleView)
        NSLayoutConstraint.activate([
            moduleView.leadingAnchor.constraint(equalTo: contentHost.leadingAnchor),
            moduleView.trailingAnchor.constraint(equalTo: contentHost.trailingAnchor),
            moduleView.topAnchor.constraint(equalTo: contentHost.topAnchor),
            moduleView.bottomAnchor.constraint(equalTo: contentHost.bottomAnchor),
        ])
    }
}
