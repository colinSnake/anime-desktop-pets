import AppKit
import SwiftUI
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterMemoryInputTests: XCTestCase {
    private func textViews(in view: NSView) -> [NSTextView] {
        if let editor = view as? NSTextView { return [editor] }
        return view.subviews.flatMap { textViews(in: $0) }
    }

    func testMemoryEditorUsesEditableThreeLineIdentityInput() throws {
        _ = NSApplication.shared
        let text = "第一行\n第二行\n第三行\n更多内容"
        let host = NSHostingView(rootView:
            CharacterMemoryEditor(text: .constant(text), identifier: "memory-editor-test")
                .frame(width: 420))
        host.frame.size = host.fittingSize
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.frame.size),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        let editor = try XCTUnwrap(textViews(in: host).first)
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        let expectedHeight = 3 * NSLayoutManager().defaultLineHeight(for: try XCTUnwrap(editor.font))
            + 2 * editor.textContainerInset.height
        XCTAssertEqual(scroll.contentSize.height, expectedHeight, accuracy: 1)
        XCTAssertTrue(editor.isEditable)
        XCTAssertEqual(editor.string, text)
        XCTAssertFalse(scroll.hasVerticalScroller)
    }

    func testMemorySingleLineInputHasConsistentControlHeight() throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView:
            CharacterMemoryTextField(title: "来源", text: .constant("本地添加"), identifier: "memory-source-test")
                .frame(width: 420))
        host.frame.size = host.fittingSize
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.frame.size),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        let field = try XCTUnwrap(findTextField(in: host, matching: "本地添加"))
        XCTAssertTrue(field.isEditable)
        XCTAssertEqual(host.frame.height, 44, accuracy: 1, "26pt input plus the label and gap")
    }

    private func findTextField(in view: NSView, matching value: String) -> NSTextField? {
        if let field = view as? NSTextField, !(field is NSSecureTextField), field.stringValue == value { return field }
        return view.subviews.lazy.compactMap { self.findTextField(in: $0, matching: value) }.first
    }
}
