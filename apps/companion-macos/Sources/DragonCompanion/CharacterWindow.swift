import AppKit
import CharacterCore
import CharacterMemory
import CharacterUI
import SwiftUI

@MainActor
final class CharacterWindow: NSWindowController {
    init(store: CharacterMemoryStore, capabilities: [CharacterCapability],
         suggestGoal: @escaping (String, String) async throws -> CharacterGoalDraft,
         chat: ((String, [CharacterChatTurn]) async throws -> String)? = nil) {
        let content = CharacterWorkspaceView(store: store, defaultName: "龙妹", capabilities: capabilities,
                                             suggestGoal: suggestGoal, chat: chat)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 600),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "角色、记忆与聊天"
        window.contentViewController = NSHostingController(rootView: content)
        window.minSize = NSSize(width: 700, height: 520)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
}
