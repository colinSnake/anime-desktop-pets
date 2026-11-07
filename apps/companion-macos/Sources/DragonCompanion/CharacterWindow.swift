import AppKit
import CharacterCore
import CharacterMemory
import CharacterUI
import SwiftUI

@MainActor
final class CharacterWindow: NSWindowController {
    init(store: CharacterMemoryStore, capabilities: [CharacterCapability]) {
        let content = CharacterWorkspaceView(store: store, defaultName: "龙妹", capabilities: capabilities)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 600),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "角色与记忆"
        window.contentViewController = NSHostingController(rootView: content)
        window.minSize = NSSize(width: 700, height: 520)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
}
