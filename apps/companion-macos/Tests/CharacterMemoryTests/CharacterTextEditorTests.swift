import AppKit
import SwiftUI
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterTextEditorTests: XCTestCase {
    private func editors(in view: NSView) -> [NSTextView] {
        if let editor = view as? NSTextView { return [editor] }
        return view.subviews.flatMap { editors(in: $0) }
    }

    func testNativePasteSelectionCopyDeleteAndBindingUsePrivatePasteboard() throws {
        _ = NSApplication.shared
        var draft = "保留前缀｜待替换｜保留后缀"
        let host = NSHostingView(rootView:
            CharacterTextEditor(text: Binding(get: { draft }, set: { draft = $0 }))
                .frame(width: 320, height: 70))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 70),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        let editor = try XCTUnwrap(editors(in: host).first)
        XCTAssertTrue(window.makeFirstResponder(editor))
        XCTAssertTrue(editor.allowsUndo)
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let pasted = "中文 🐾\n第二行\n" + String(repeating: "长文本滚动\n", count: 20)
        pasteboard.setString(pasted, forType: .string)
        editor.setSelectedRange((editor.string as NSString).range(of: "待替换"))
        XCTAssertTrue(editor.readSelection(from: pasteboard, type: .string))
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
        XCTAssertEqual(draft, "保留前缀｜\(pasted)｜保留后缀")
        XCTAssertEqual(editor.string, draft)
        editor.setSelectedRange((editor.string as NSString).range(of: pasted))
        pasteboard.clearContents()
        let nativeType = try XCTUnwrap(editor.writablePasteboardTypes.first)
        XCTAssertTrue(editor.writeSelection(to: pasteboard, types: [nativeType]))
        XCTAssertEqual(pasteboard.string(forType: nativeType), pasted)
        editor.delete(nil)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
        XCTAssertEqual(draft, "保留前缀｜｜保留后缀")
        XCTAssertNotNil(editor.menu, "Native editing context menu must remain available")
        XCTAssertFalse(window.isVisible)
    }

    func testHiddenIndicatorsKeepScrollingAndDoNotHideOuterPageScroller() throws {
        _ = NSApplication.shared
        let text = (1...50).map { "第\($0)行合成内容" }.joined(separator: "\n")
        let host = NSHostingView(rootView:
            ScrollView {
                CharacterTextEditor(text: .constant(text)).frame(height: 70)
                TextField("测试来源", text: .constant("合成来源"))
                Color.clear.frame(height: 900)
            }.frame(width: 300, height: 200))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
        let editor = try XCTUnwrap(editors(in: host).first)
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        // Force the legacy style locally; never change the user's system scrollbar preference.
        scroll.scrollerStyle = .legacy
        // SwiftUI may re-enable these when text/layout changes; policy must stay effective.
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        XCTAssertFalse(scroll.hasVerticalScroller)
        XCTAssertFalse(scroll.hasHorizontalScroller)
        editor.scrollRangeToVisible(NSRange(location: editor.string.utf16.count, length: 0))
        XCTAssertGreaterThan(scroll.contentView.bounds.minY, 0)
        XCTAssertEqual(editor.string, text)
        let outer = try XCTUnwrap(scroll.enclosingScrollView)
        XCTAssertTrue(outer.hasVerticalScroller, "Input policy must not leak to outer-page scrolling")
        func textField(in view: NSView) -> NSTextField? {
            if let field = view as? NSTextField { return field }
            return view.subviews.lazy.compactMap { textField(in: $0) }.first
        }
        let field = try XCTUnwrap(textField(in: host))
        XCTAssertTrue(window.makeFirstResponder(field))
        host.needsLayout = true
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
        XCTAssertTrue(outer.hasVerticalScroller, "A field editor must never be mistaken for the outer page's document")
        XCTAssertFalse(window.isVisible)
    }

    func testSeveralEditorsKeepIndependentScrollbarPoliciesInOneForm() throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView:
            VStack {
                ForEach(0..<4) { index in
                    CharacterIdentityEditor(title: "参数\(index)", text: .constant("第\(index)项\n多行合成文本"))
                }
            }.frame(width: 400))
        host.frame.size = host.fittingSize
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.frame.size),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        let inputs = editors(in: host)
        XCTAssertEqual(inputs.count, 4)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
        for editor in inputs {
            let scroll = try XCTUnwrap(editor.enclosingScrollView)
            scroll.hasVerticalScroller = true
            scroll.hasHorizontalScroller = true
            XCTAssertFalse(scroll.hasVerticalScroller, editor.string)
            XCTAssertFalse(scroll.hasHorizontalScroller, editor.string)
        }
        XCTAssertFalse(window.isVisible)
    }
}
