import AppKit
import XCTest
@testable import PetCompanion

@MainActor
final class ApplicationMenuTests: XCTestCase {
    private func items(in menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { [$0] + ($0.submenu.map { items(in: $0) } ?? []) }
    }

    func testStandardEditingCommandsUseNativeResponderChainAndShortcuts() throws {
        _ = NSApplication.shared
        let menu = ApplicationMenu.makeMainMenu()
        let commands: [(String, String, NSEvent.ModifierFlags)] = [
            ("undo:", "z", .command), ("redo:", "z", [.command, .shift]),
            ("cut:", "x", .command), ("copy:", "c", .command),
            ("paste:", "v", .command), ("selectAll:", "a", .command),
            ("pasteAsPlainText:", "v", [.command, .option, .shift])
        ]
        for (action, key, modifiers) in commands {
            let item = try XCTUnwrap(items(in: menu).first { $0.action == NSSelectorFromString(action) }, action)
            XCTAssertNil(item.target, "Resolve the focused native input, never a global clipboard handler")
            XCTAssertEqual(item.keyEquivalent, key)
            XCTAssertEqual(item.keyEquivalentModifierMask, modifiers)
            XCTAssertTrue(try XCTUnwrap(item.menu).autoenablesItems)
        }
        XCTAssertNotNil(items(in: menu).first { $0.action == #selector(NSApplication.terminate(_:)) })
    }

    func testNativeSelectAllShortcutAndTextUndoRedoWithoutShowingWindow() throws {
        _ = NSApplication.shared
        let menu = ApplicationMenu.makeMainMenu()
        let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        editor.isRichText = false
        editor.allowsUndo = true
        editor.string = "合成文字 🐾"
        let window = NSWindow(contentRect: editor.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = editor
        defer { window.close() }
        XCTAssertTrue(window.makeFirstResponder(editor))
        // A hidden window is deliberately not the application's key window. Supply the
        // fixture responder only in this test; production items must retain nil targets.
        for item in items(in: menu) where item.action != nil { item.target = editor }
        func press(_ key: String, modifiers: NSEvent.ModifierFlags = .command) throws -> Bool {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                timestamp: 0, windowNumber: window.windowNumber, context: nil,
                characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: 0))
            return menu.performKeyEquivalent(with: event)
        }
        XCTAssertTrue(try press("a"))
        XCTAssertEqual(editor.selectedRange(), NSRange(location: 0, length: editor.string.utf16.count))
        editor.insertText("替换文本", replacementRange: editor.selectedRange())
        editor.breakUndoCoalescing()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
        XCTAssertEqual(editor.string, "替换文本")
        let undoManager = try XCTUnwrap(editor.undoManager)
        XCTAssertTrue(undoManager.canUndo)
        undoManager.undo()
        XCTAssertEqual(editor.string, "合成文字 🐾")
        XCTAssertTrue(undoManager.canRedo)
        undoManager.redo()
        XCTAssertEqual(editor.string, "替换文本")
        XCTAssertFalse(window.isVisible)
    }
}
