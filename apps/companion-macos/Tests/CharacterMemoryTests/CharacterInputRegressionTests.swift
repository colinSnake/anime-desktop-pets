import AppKit
import SwiftUI
import CharacterCore
import CharacterMemory
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterInputRegressionTests: XCTestCase {
    private func native<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        if let result = view as? T { return [result] }
        return view.subviews.flatMap { native(type, in: $0) }
    }
    private func settle(_ view: NSView) {
        view.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.06))
    }
    private func window<V: View>(_ root: V) -> (NSWindow, NSHostingView<V>) {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 360),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        settle(host)
        return (window, host)
    }

    func testNativeUndoUpdatesRealSwiftUIBinding() throws {
        var value = "合成原文"
        let (win, host) = window(CharacterTextEditor(text: Binding(get: {value}, set: {value = $0})))
        defer { win.close() }
        let text = try XCTUnwrap(native(NSTextView.self, in: host).first)
        XCTAssertTrue(win.makeFirstResponder(text))
        text.setSelectedRange(NSRange(location: 0, length: text.string.utf16.count))
        text.insertText("替换内容 🐾", replacementRange: text.selectedRange())
        text.breakUndoCoalescing()
        settle(host)
        XCTAssertEqual(value, "替换内容 🐾")
        let undo = try XCTUnwrap(text.undoManager)
        undo.undo()
        XCTAssertEqual(value, "合成原文", "Undo must synchronize before a subsequent Save")
        settle(host)
        XCTAssertEqual(value, "合成原文")
        undo.redo()
        XCTAssertEqual(value, "替换内容 🐾", "Redo must synchronize before a subsequent Save")
        settle(host)
        XCTAssertEqual(value, "替换内容 🐾")
        XCTAssertFalse(win.isVisible)
    }

    func testWrappedEditorDoesNotChangeUnwrappedEditorScrollbar() throws {
        let (win, host) = window(VStack {
            CharacterTextEditor(text: .constant("隐藏滚动条的目标"))
            TextEditor(text: .constant(String(repeating: "保持原策略的独立原生编辑器\n", count: 30)))
        })
        defer { win.close() }
        let texts = native(NSTextView.self, in: host)
        settle(host)
        let unwrapped = try XCTUnwrap(texts.first { $0.string.hasPrefix("保持") })
        let scroll = try XCTUnwrap(unwrapped.enclosingScrollView)
        scroll.hasVerticalScroller = true
        XCTAssertTrue(scroll.hasVerticalScroller, "A local scrollbar policy must not mutate an unrelated sibling editor")
        XCTAssertFalse(win.isVisible)
    }

    private struct IdentityPairForm: View {
        @ObservedObject var model: CharacterWorkspaceModel
        var body: some View {
            VStack {
                CharacterIdentityEditor(title: "性格", text: $model.identity.personality)
                CharacterIdentityEditor(title: "关系", text: $model.identity.relationship)
            }
        }
    }

    func testUndoDoesNotOverwritePendingModelChangeInAnotherField() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic-input")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        model.identity.personality = "原始性格"
        model.identity.relationship = "原始关系"
        let (win, host) = window(IdentityPairForm(model: model))
        defer { win.close() }
        let editor = try XCTUnwrap(native(NSTextView.self, in: host).first { $0.string == "原始性格" })
        XCTAssertTrue(win.makeFirstResponder(editor))
        editor.selectAll(nil)
        editor.insertText("修改性格", replacementRange: editor.selectedRange())
        editor.breakUndoCoalescing()
        settle(host)
        // This model update has not yet been rendered by SwiftUI. Undo in the
        // first field must not publish the second field's stale native text.
        model.identity.relationship = "刚更新的关系"
        try XCTUnwrap(editor.undoManager).undo()
        XCTAssertEqual(model.identity.personality, "原始性格")
        XCTAssertEqual(model.identity.relationship, "刚更新的关系")
        settle(host)
        XCTAssertTrue(native(NSTextView.self, in: host).contains { $0.string == "刚更新的关系" })
        XCTAssertFalse(win.isVisible)
    }

    private struct RealComposerForm: View {
        @ObservedObject var model: CharacterWorkspaceModel
        @FocusState private var focused: Bool
        var body: some View { CharacterChatComposer(model: model, isFocused: $focused) }
    }
    private struct RealIdentityForm: View {
        @ObservedObject var model: CharacterWorkspaceModel
        var body: some View { CharacterIdentityEditor(title: "性格", text: $model.identity.personality) }
    }


    func testActualComposerShiftReturnMustNotSend() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "audit")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成测试角色", chat: { _, _, _ in "合成离线回复" })
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        model.chatDraft = "应保留的合成聊天草稿"
        let (win, host) = window(RealComposerForm(model: model))
        defer { win.close() }
        let field = try XCTUnwrap(native(NSTextField.self, in: host).first)
        XCTAssertTrue(win.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .shift,
            timestamp: 0, windowNumber: win.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        NSApp.postEvent(event, atStart: true)
        let queued = try XCTUnwrap(NSApp.nextEvent(matching: .keyDown, until: Date(timeIntervalSinceNow: 1), inMode: .default, dequeue: true))
        // Go through AppKit, including the composer's pre-dispatch key policy.
        // Direct editor.keyDown would bypass that production path.
        NSApp.sendEvent(queued)
        for _ in 0..<10 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(model.chatTurns.isEmpty, "Shift+Enter must not send the current draft")
        XCTAssertEqual(model.chatDraft, "应保留的合成聊天草稿\n")
        XCTAssertFalse(win.isVisible)
    }

    func testActualIdentitySaveAfterUndoMustPersistVisibleText() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "audit")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成测试角色")
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(model.canSaveIdentity)
        model.identity.personality = "原始合成性格"
        let (win, host) = window(RealIdentityForm(model: model))
        defer { win.close() }
        let editor = try XCTUnwrap(native(NSTextView.self, in: host).first)
        XCTAssertTrue(win.makeFirstResponder(editor))
        editor.setSelectedRange(NSRange(location: 0, length: editor.string.utf16.count))
        editor.insertText("准备撤销的性格", replacementRange: editor.selectedRange())
        editor.breakUndoCoalescing()
        for _ in 0..<10 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(model.identity.personality, "准备撤销的性格")
        win.perform(Selector(("undo:")), with: nil)
        let visible = editor.string
        XCTAssertEqual(visible, "原始合成性格")
        XCTAssertEqual(model.identity.personality, visible)
        model.saveIdentity()
        try await assertSavedPersonality(visible, in: store)
        try XCTUnwrap(editor.undoManager).redo()
        XCTAssertEqual(editor.string, "准备撤销的性格")
        XCTAssertEqual(model.identity.personality, editor.string)
        model.saveIdentity()
        try await assertSavedPersonality(editor.string, in: store)
        XCTAssertFalse(win.isVisible)
    }
    func testUnmountingEditorReleasesScrollbarPolicy() throws {
        let (win, host) = window(AnyView(CharacterTextEditor(text: .constant("卸载测试"))))
        defer { win.close() }
        let editor = try XCTUnwrap(native(NSTextView.self, in: host).first)
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        scroll.hasVerticalScroller = true
        XCTAssertFalse(scroll.hasVerticalScroller)
        host.rootView = AnyView(Color.clear)
        settle(host)
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        XCTAssertTrue(scroll.hasVerticalScroller, "Unmounting must stop observing the old editor")
        XCTAssertTrue(scroll.hasHorizontalScroller)
        XCTAssertFalse(win.isVisible)
    }

    private func assertSavedPersonality(_ expected: String, in store: CharacterMemoryStore) async throws {
        var actual = ""
        for _ in 0..<100 {
            actual = try await store.loadIdentity(defaultName: "合成测试角色").personality
            if actual == expected { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(actual, expected, "Saved text must match the visible post-undo/redo text")
    }
}
