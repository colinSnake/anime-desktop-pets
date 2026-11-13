import AppKit
import CharacterCore
import CharacterMemory
import CharacterUI
import SwiftUI

@MainActor
final class CharacterWorkspaceController: NSViewController {
    private let navigation: CharacterWorkspaceNavigation
    private let hostingController: NSHostingController<CharacterWorkspaceView>

    init(content: CharacterWorkspaceView, navigation: CharacterWorkspaceNavigation) {
        self.navigation = navigation
        hostingController = NSHostingController(rootView: content)
        super.init(nibName: nil, bundle: nil)
        addChild(hostingController)
        view = NSView()
        let hostedView = hostingController.view
        hostedView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hostedView)
        NSLayoutConstraint.activate([
            hostedView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostedView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hostedView.topAnchor.constraint(equalTo: view.topAnchor),
            hostedView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    func select(_ page: CharacterWorkspacePage) {
        navigation.page = page
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.applyCompactOverlayScrollbars(in: self.hostingController.view)
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        applyCompactOverlayScrollbars(in: hostingController.view)
    }

    private func applyCompactOverlayScrollbars(in view: NSView) {
        if let scroll = view as? NSScrollView {
            scroll.scrollerStyle = .overlay
            scroll.verticalScroller?.controlSize = .mini
        }
        for child in view.subviews {
            applyCompactOverlayScrollbars(in: child)
        }
    }
}

@MainActor
final class CharacterWindow: NSWindowController {
    init(store: CharacterMemoryStore, capabilities: [CharacterCapability],
         suggestGoal: ((String, String) async throws -> CharacterGoalDraft)?,
         chat: ((String, [CharacterChatTurn]) async throws -> String)? = nil,
         offlinePreview: Bool = false) {
        let content = CharacterWorkspaceView(store: store, defaultName: "龙妹", capabilities: capabilities,
                                             suggestGoal: suggestGoal, chat: chat)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 600),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "角色、记忆与聊天"
        window.backgroundColor = WorkspacePalette.canvas
        window.contentViewController = NSHostingController(rootView: VStack(spacing: 0) {
            if offlinePreview {
                Text("离线验收 · 使用临时资料 · 不连接在线服务 · 关闭窗口即可退出")
                    .font(.callout).foregroundStyle(.secondary).padding(10)
            }
            content
        })
        window.minSize = NSSize(width: 700, height: 520)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
}
