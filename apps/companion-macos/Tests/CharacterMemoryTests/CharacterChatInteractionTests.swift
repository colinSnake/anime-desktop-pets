import AppKit
import CharacterCore
import CharacterMemory
import SwiftUI
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterChatInteractionTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    private func makeModel() throws -> (URL, CharacterWorkspaceModel) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic-chat-interaction")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in
            "仅用于离线测试的合成回复"
        })
        return (directory, model)
    }

    private func makeWindow<V: View>(_ root: V) -> (NSWindow, NSHostingView<V>) {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 480),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        return (window, host)
    }

    private func settle() async throws {
        try await Task.sleep(nanoseconds: 80_000_000)
    }

    private func focusField(in host: NSView, window: NSWindow, text: String) async throws -> NSTextView {
        host.layoutSubtreeIfNeeded()
        let field = try XCTUnwrap(descendants(host).compactMap { $0 as? NSTextField }
            .first { $0.isEditable && $0.stringValue == text })
        XCTAssertTrue(window.makeFirstResponder(field))
        try await settle()
        return try XCTUnwrap(field.currentEditor() as? NSTextView)
    }

    private func key(in window: NSWindow, modifiers: NSEvent.ModifierFlags = [], keyCode: UInt16 = 36) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: keyCode))
    }

    private func sendKey(in window: NSWindow, modifiers: NSEvent.ModifierFlags = [], keyCode: UInt16 = 36, throughApplication: Bool = true) throws {
        let event = try key(in: window, modifiers: modifiers, keyCode: keyCode)
        // Seed currentEvent as the real AppKit event loop does. Application dispatch
        // exercises local key policies; direct dispatch lets unhandled keys reach a
        // hidden window that cannot be the application's key window. No global input.
        NSApplication.shared.postEvent(event, atStart: true)
        let queued = try XCTUnwrap(NSApplication.shared.nextEvent(matching: .keyDown,
            until: Date(timeIntervalSinceNow: 1), inMode: .default, dequeue: true))
        XCTAssertEqual(queued.windowNumber, window.windowNumber)
        if throughApplication {
            NSApplication.shared.sendEvent(queued)
        } else {
            window.sendEvent(queued)
        }
    }

    func testShiftReturnInsertsNewlineAtSelectionWithoutSendingAndSupportsUndo() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let (directory, model) = try makeModel()
            defer { try? FileManager.default.removeItem(at: directory) }
            model.chatDraft = "保留前缀｜待替换｜保留后缀"
            let (window, host) = makeWindow(CharacterChatView(model: model)
                .frame(width: 760, height: 480).environment(\.colorScheme, scheme))
            defer { window.close() }
            try await settle()
            let editor = try await focusField(in: host, window: window, text: model.chatDraft)
            XCTAssertTrue(editor.allowsUndo, "The real composer must enable undo without a test override")
            editor.setSelectedRange((editor.string as NSString).range(of: "待替换"))
            try sendKey(in: window, modifiers: .shift)
            try await settle()
            XCTAssertEqual(model.chatDraft, "保留前缀｜\n｜保留后缀")
            XCTAssertEqual(editor.string, model.chatDraft)
            XCTAssertTrue(model.chatTurns.isEmpty, "A newline must never send the draft")
            XCTAssertTrue(window.firstResponder === editor)
            let undo = try XCTUnwrap(editor.undoManager)
            XCTAssertTrue(undo.canUndo)
            undo.undo()
            XCTAssertEqual(editor.string, "保留前缀｜待替换｜保留后缀")
            XCTAssertEqual(model.chatDraft, editor.string, "Undo must update the sendable draft, not just visible text")
            undo.redo()
            XCTAssertEqual(editor.string, "保留前缀｜\n｜保留后缀")
            XCTAssertEqual(model.chatDraft, editor.string)
            undo.undo()
            editor.insertText("！", replacementRange: NSRange(location: editor.string.utf16.count, length: 0))
            try await settle()
            XCTAssertEqual(model.chatDraft, "保留前缀｜待替换｜保留后缀！")
            XCTAssertFalse(window.isVisible)
        }
    }

    func testShiftKeypadEnterInsertsNewlineWithoutSending() async throws {
        let (directory, model) = try makeModel()
        defer { try? FileManager.default.removeItem(at: directory) }
        model.chatDraft = "合成草稿"
        let (window, host) = makeWindow(CharacterChatView(model: model).frame(width: 760, height: 480))
        defer { window.close() }
        try await settle()
        let editor = try await focusField(in: host, window: window, text: model.chatDraft)
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        try sendKey(in: window, modifiers: [.shift, .numericPad], keyCode: 76)
        try await settle()
        XCTAssertEqual(model.chatDraft, "合成草稿\n")
        XCTAssertTrue(model.chatTurns.isEmpty)
        XCTAssertFalse(window.isVisible)
    }

    func testReturnSubmitsAndEscapeStillDismissesNativeEditor() async throws {
        let (directory, model) = try makeModel()
        defer { try? FileManager.default.removeItem(at: directory) }
        model.chatDraft = "合成消息"
        let (window, host) = makeWindow(CharacterChatView(model: model).frame(width: 760, height: 480))
        defer { window.close() }
        try await settle()
        let editor = try await focusField(in: host, window: window, text: model.chatDraft)
        try sendKey(in: window, throughApplication: false)
        try await settle()
        XCTAssertEqual(model.chatDraft, "")
        XCTAssertEqual(model.chatTurns.map(\.role), [.user, .assistant])
        XCTAssertEqual(model.chatTurns.first?.text, "合成消息")
        editor.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
        try await settle()
        XCTAssertFalse(window.firstResponder === editor)
        XCTAssertFalse(window.isVisible)
    }

    func testShiftReturnDoesNotChangeMarkedTextOrAnUnrelatedInput() async throws {
        let (directory, model) = try makeModel()
        defer { try? FileManager.default.removeItem(at: directory) }
        model.chatDraft = "聊天草稿"
        var unrelated = "其他输入框"
        let (window, host) = makeWindow(VStack {
            CharacterChatView(model: model)
            TextField("其他输入", text: Binding(get: { unrelated }, set: { unrelated = $0 }))
        }.frame(width: 760, height: 480))
        defer { window.close() }
        try await settle()
        let editor = try await focusField(in: host, window: window, text: model.chatDraft)
        editor.setMarkedText("候选拼音", selectedRange: NSRange(location: 4, length: 0),
                             replacementRange: NSRange(location: editor.string.utf16.count, length: 0))
        XCTAssertTrue(editor.hasMarkedText())
        let marked = editor.string
        try sendKey(in: window, modifiers: .shift)
        try await settle()
        XCTAssertEqual(editor.string, marked, "The input method must handle Return while composing")
        XCTAssertTrue(editor.hasMarkedText())
        XCTAssertTrue(model.chatTurns.isEmpty)
        editor.unmarkText()
        let otherEditor = try await focusField(in: host, window: window, text: unrelated)
        try sendKey(in: window, modifiers: .shift)
        try await settle()
        XCTAssertEqual(otherEditor.string, "其他输入框", "The chat policy must not intercept other fields")
        XCTAssertEqual(unrelated, "其他输入框")
        XCTAssertTrue(model.chatTurns.isEmpty)
        XCTAssertFalse(window.isVisible)
    }

    func testNewRepliesRemainVisibleAfterHistoryReachesItsTurnLimit() async throws {
        try await assertNewRepliesRemainVisible(userText: "合成消息",
            replyText: String(repeating: "离线合成回复，用于检查消息滚动。", count: 30),
            saturatedRound: 6, expectedCount: 12)
    }

    func testNewRepliesRemainVisibleWhenCharacterBudgetKeepsCountBelowTurnLimit() async throws {
        try await assertNewRepliesRemainVisible(userText: String(repeating: "问", count: 1_200),
            replyText: String(repeating: "答", count: 1_200), saturatedRound: 3, expectedCount: 5)
    }

    private func assertNewRepliesRemainVisible(userText: String, replyText: String,
                                               saturatedRound: Int, expectedCount: Int) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CharacterMemoryStore(stateDirectory: directory, petID: "synthetic-bounded-chat")
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", chat: { _, _, _ in replyText })
        let (window, host) = makeWindow(CharacterChatView(model: model).frame(width: 760, height: 480))
        defer { window.close() }
        try await settle()
        for round in 0..<(saturatedRound + 3) {
            if round >= saturatedRound {
                let scroll = try transcriptScroll(in: host)
                scroll.contentView.scroll(to: .zero)
                scroll.reflectScrolledClipView(scroll.contentView)
                try await settle()
            }
            model.sendChat(userText)
            for _ in 0..<100 where model.isChatSending { try await Task.sleep(nanoseconds: 5_000_000) }
            XCTAssertFalse(model.isChatSending)
            try await Task.sleep(nanoseconds: 600_000_000)
            host.layoutSubtreeIfNeeded()
            if round >= saturatedRound {
                XCTAssertEqual(model.chatTurns.count, expectedCount)
                let scroll = try transcriptScroll(in: host)
                let document = try XCTUnwrap(scroll.documentView)
                XCTAssertGreaterThan(document.bounds.height, scroll.documentVisibleRect.height)
                XCTAssertGreaterThanOrEqual(scroll.documentVisibleRect.maxY, document.bounds.maxY - 2,
                    "Round \(round): the new reply must remain visible with \(expectedCount) bounded messages")
            }
        }
        XCTAssertFalse(window.isVisible)
    }

    private func transcriptScroll(in host: NSView) throws -> NSScrollView {
        try XCTUnwrap(descendants(host).compactMap { $0 as? NSScrollView }
            .filter { !($0.documentView is NSTextView) }
            .max { ($0.documentView?.bounds.height ?? 0) < ($1.documentView?.bounds.height ?? 0) })
    }
}
