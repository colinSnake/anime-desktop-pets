import AppKit
import SwiftUI

@MainActor
final class CompanionWorkspaceWindow: NSWindowController, NSWindowDelegate {
    enum Theme: Int, CaseIterable {
        case system
        case dark
        case light

        var symbol: String {
            switch self {
            case .system: "circle.lefthalf.striped.horizontal"
            case .dark: "moon.fill"
            case .light: "sun.max.fill"
            }
        }

        var title: String {
            switch self {
            case .system: "跟随系统"
            case .dark: "深色主题"
            case .light: "浅色主题"
            }
        }

        var preferredColorScheme: ColorScheme? {
            switch self {
            case .system: nil
            case .dark: .dark
            case .light: .light
            }
        }
    }

    struct Actions {
        var petStatus: () -> String
        var petServiceConnected: () -> Bool
        var petActionTitle: () -> String
        var petIsVisible: () -> Bool
        var togglePet: () -> Void
        var canControlPets: () -> Bool
        var canTogglePause: () -> Bool
        var petInstances: () -> [WorkspacePetInstance]
        var toggleInstance: (String) -> Void
        var cloneInstance: (String) -> Void
        var deleteInstance: (String) -> Void
        var managePets: () -> Void
        var pauseTitle: () -> String
        var isPaused: () -> Bool
        var togglePause: () -> Void
        var openData: () -> Void
        var openAccessibility: () -> Void
        var canManagePets: () -> Bool
        var canOpenAccessibility: () -> Bool
    }

    private let modules: [WorkspaceSection: NSViewController]
    private let shellModel: WorkspaceShellModel
    private let speechController: SpeechSettingsWindow
    private let actions: Actions

    init(models: ModelManagerWindow, speech: SpeechSettingsWindow, character: CharacterWorkspaceController,
         actions: Actions, initialSection: WorkspaceSection = .pets) {
        self.actions = actions
        speechController = speech
        shellModel = WorkspaceShellModel(section: initialSection)
        modules = [
            .pets: WorkspacePetsPageController(actions: actions),
            .models: models,
            .speech: speech,
            .live: speech,
            .characterChat: character,
            .character: character,
            .characterMemories: character,
            .characterCapabilities: character,
            .advanced: WorkspaceActionPageController(title: "高级", accent: WorkspacePalette.accent,
                status: { "数据保存在本机用户目录；系统权限由 macOS 管理。" },
                actionTitle: "系统操作", actions: [
                    .init("打开数据文件夹", symbol: "folder", run: actions.openData),
                    .init("窗口尺寸辅助功能权限", symbol: "accessibility", run: actions.openAccessibility,
                          enabled: actions.canOpenAccessibility),
                ]),
        ]

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 790),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = AppCopy.name
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 1000, height: 680)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.appearance = appearance(for: shellModel.theme)
        window.delegate = self
        shellModel.onSelect = { [weak self] section in self?.preparePage(section) }
        shellModel.onThemeChanged = { [weak self] theme in
            self?.window?.appearance = self?.appearance(for: theme)
        }
        let root = WorkspaceShellView(model: shellModel, modules: modules,
                                      isServiceConnected: actions.petServiceConnected,
                                      tagline: AppCopy.tagline,
                                      appIcon: NSApp.applicationIconImage)
        let host = NSHostingController(rootView: root)
        window.contentViewController = host
        preparePage(initialSection)
        window.center()

    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    func open(_ section: WorkspaceSection) {
        shellModel.select(section)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func refreshPetControls() {
        (modules[.pets] as? WorkspacePetsPageController)?.refresh()
        shellModel.refreshStatus(actions.petServiceConnected())
    }

    func windowWillClose(_ notification: Notification) {
        speechController.stopForWindowClose()
    }

    private func preparePage(_ section: WorkspaceSection) {
        if section == .pets { refreshPetControls() }
        if section.isCharacterPage, let character = modules[section] as? CharacterWorkspaceController {
            character.select(section.characterPage)
        }
        if section == .speech { speechController.selectPage(.voice) }
        if section == .live { speechController.selectPage(.live) }
    }

    private func appearance(for theme: Theme) -> NSAppearance? {
        switch theme {
        case .system: nil
        case .dark: NSAppearance(named: .darkAqua)
        case .light: NSAppearance(named: .aqua)
        }
    }
}
