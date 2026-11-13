import AppKit
import SwiftUI
import XCTest
@testable import DragonCompanion

@MainActor
final class WorkspaceSearchFieldTests: XCTestCase {
    private func field(in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField { return field }
        return view.subviews.lazy.compactMap { self.field(in: $0) }.first
    }

    private func snapshot(_ view: NSView, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["ADP_UI_SNAPSHOT_DIR"] else { return }
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let directory = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: directory.appendingPathComponent("search-\(name).png"))
    }

    func testPlaceholderTextAndFieldEditorKeepCenteredGeometryAcrossFocusChanges() async throws {
        _ = NSApplication.shared
        for scheme in [ColorScheme.light, .dark] {
            for initial in ["", "Ag搜索龙妹"] {
                var text = initial
                let host = NSHostingView(rootView:
                    WorkspaceSearchField(prompt: "Ag搜索龙妹", text: Binding(get: { text }, set: { text = $0 }))
                        .frame(width: 280).controlSize(.small).padding(10)
                        .background(Color(nsColor: WorkspacePalette.canvas))
                        .environment(\.colorScheme, scheme))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 46),
                                      styleMask: [.titled], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                defer { window.close() }
                window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
                window.contentView = host
                window.setContentSize(NSSize(width: 300, height: 46))
                try await Task.sleep(nanoseconds: 40_000_000)
                host.layoutSubtreeIfNeeded()
                let input = try XCTUnwrap(field(in: host))
                let before = host.convert(input.bounds, from: input)
                let font = try XCTUnwrap(input.font)
                let label = "\(scheme)-\(initial.isEmpty ? "empty" : "filled")"
                XCTAssertEqual(host.fittingSize.height, 46, accuracy: 0.01)
                XCTAssertEqual(before.midY, host.bounds.midY, accuracy: 0.5, label)
                XCTAssertEqual(before.height, input.intrinsicContentSize.height, accuracy: 0.01, label)
                try snapshot(host, name: "\(label)-idle")

                XCTAssertTrue(window.makeFirstResponder(input))
                try await Task.sleep(nanoseconds: 40_000_000)
                host.layoutSubtreeIfNeeded()
                let editor = try XCTUnwrap(input.currentEditor() as? NSTextView)
                let editing = host.convert(editor.bounds, from: editor)
                // Check native geometry, not just the surrounding 26pt SwiftUI frame.
                // The old 11pt field measured 13pt idle vs 14pt editing and moved up 1pt.
                XCTAssertEqual(editing.minY, before.minY, accuracy: 0.01, label)
                XCTAssertEqual(editing.height, before.height, accuracy: 0.01, label)
                XCTAssertEqual(editor.font, font, label)
                let caret = editor.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil)
                XCTAssertGreaterThan(caret.height, 0, label)
                let editorOnScreen = window.convertToScreen(editor.convert(editor.bounds, to: nil))
                XCTAssertEqual(caret.midY, editorOnScreen.midY, accuracy: 0.5, label)
                XCTAssertLessThanOrEqual(caret.height, before.height + 0.5, label)
                editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
                try snapshot(host, name: "\(label)-editing")

                // Exercise the real field editor and SwiftUI binding without global input events.
                editor.insertText("版本 2.0", replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
                try await Task.sleep(nanoseconds: 40_000_000)
                XCTAssertEqual(text, "版本 2.0", label)
                XCTAssertTrue(window.makeFirstResponder(nil))
                try await Task.sleep(nanoseconds: 40_000_000)
                host.layoutSubtreeIfNeeded()
                let after = host.convert(input.bounds, from: input)
                XCTAssertEqual(after.minY, before.minY, accuracy: 0.01, label)
                XCTAssertEqual(after.height, before.height, accuracy: 0.01, label)
                XCTAssertEqual(input.stringValue, text, label)
                try snapshot(host, name: "\(label)-blurred")
                XCTAssertFalse(window.isVisible)
            }
        }
    }

    func testDisabledSearchKeepsItsTextLineAndCompactHeight() async throws {
        _ = NSApplication.shared
        for scheme in [ColorScheme.light, .dark] {
            let host = NSHostingView(rootView:
                WorkspaceSearchField(prompt: "搜索名称、版本或路径", text: .constant("龙妹"))
                    .frame(width: 280).controlSize(.small).disabled(true)
                    .environment(\.colorScheme, scheme))
            host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            host.frame.size = host.fittingSize
            host.layoutSubtreeIfNeeded()
            let input = try XCTUnwrap(field(in: host))
            XCTAssertFalse(input.isEnabled)
            XCTAssertFalse(input.acceptsFirstResponder)
            XCTAssertEqual(host.fittingSize.height, 26, accuracy: 0.01)
            XCTAssertEqual(host.convert(input.bounds, from: input).midY, host.bounds.midY, accuracy: 0.5)
            try snapshot(host, name: "\(scheme)-disabled")
        }
    }
}
