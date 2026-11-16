import AppKit
import SwiftUI
import XCTest
@testable import PetCompanion

@MainActor
final class NativeInputEditingTests: XCTestCase {
    private func fields(in view: NSView) -> [NSTextField] {
        if let field = view as? NSTextField { return [field] }
        return view.subviews.flatMap { fields(in: $0) }
    }

    func testSingleLineAndSecureFieldsKeepNativePasteAndSecretProtection() throws {
        _ = NSApplication.shared
        for secure in [false, true] {
            var draft = "合成资料"
            let binding = Binding(get: { draft }, set: { draft = $0 })
            let host = NSHostingView(rootView: Group {
                if secure { SecureField("测试密钥", text: binding) }
                else { TextField("测试输入", text: binding) }
            }.frame(width: 320, height: 80))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 80),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            defer { window.close() }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
            let field = try XCTUnwrap(fields(in: host).first)
            XCTAssertEqual(field is NSSecureTextField, secure)
            XCTAssertTrue(window.makeFirstResponder(field))
            let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
            let board = NSPasteboard.withUniqueName()
            defer { board.releaseGlobally() }
            let pasted = "粘贴测试 🐾"
            board.setString(pasted, forType: .string)
            editor.selectAll(nil)
            XCTAssertTrue(editor.readSelection(from: board, type: .string))
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
            XCTAssertEqual(editor.string, pasted)
            XCTAssertEqual(draft, pasted)
            editor.selectAll(nil)
            let copy = NSMenuItem(title: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
            let cut = NSMenuItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
            XCTAssertEqual(editor.validateMenuItem(copy), !secure)
            XCTAssertEqual(editor.validateMenuItem(cut), !secure)
            field.isEnabled = false
            XCTAssertFalse(field.acceptsFirstResponder)
            XCTAssertFalse(window.isVisible)
        }
    }

    func testVerticalTextFieldRemainsNativeAndScrollsWithoutVisibleIndicators() throws {
        _ = NSApplication.shared
        let text = (1...25).map { "合成文字第\($0)行" }.joined(separator: "\n")
        let host = NSHostingView(rootView:
            TextField("测试聊天输入", text: .constant(text), axis: .vertical)
                .lineLimit(2...7).frame(width: 300))
        host.frame.size = host.fittingSize
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.frame.size),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.04))
        let field = try XCTUnwrap(fields(in: host).first)
        XCTAssertTrue(window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        XCTAssertTrue(editor.isEditable)
        XCTAssertTrue(editor.isSelectable)
        XCTAssertEqual(editor.string, text)
        if let scroll = editor.enclosingScrollView {
            XCTAssertFalse(scroll.hasVerticalScroller)
            XCTAssertFalse(scroll.hasHorizontalScroller)
        }
        XCTAssertFalse(window.isVisible)
    }
}
