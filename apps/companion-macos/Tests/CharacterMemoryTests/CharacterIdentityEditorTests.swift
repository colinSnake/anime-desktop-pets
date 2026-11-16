import AppKit
import SwiftUI
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterIdentityEditorTests: XCTestCase {
    private func findEditor(in view: NSView) -> NSTextView? {
        if let editor = view as? NSTextView { return editor }
        return view.subviews.lazy.compactMap { self.findEditor(in: $0) }.first
    }

    func testIdentityEditorsDefaultToThreeNativeTextLinesInBothThemes() throws {
        _ = NSApplication.shared
        for scheme in [ColorScheme.light, .dark] {
            for (title, text) in [("名称", "测试名称"), ("性格", "安静\n温和\n认真"),
                                  ("表达方式", String(repeating: "较长的合成文字，需要在框内滚动。", count: 30)),
                                  ("与你的关系", "")] {
                let host = NSHostingView(rootView:
                    CharacterIdentityEditor(title: title, text: .constant(text))
                        .padding(20).frame(width: 500)
                        .background(Color(nsColor: ManagementSurfacePalette.canvas))
                        .environment(\.colorScheme, scheme))
                host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
                host.frame.size = host.fittingSize
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.frame.size),
                                      styleMask: .borderless, backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                defer { window.close() }
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
                host.layoutSubtreeIfNeeded()
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
                let editor = try XCTUnwrap(findEditor(in: host))
                // Hidden hosting views realize their first native editor lazily on traversal.
                // Settle the attached native tree before inspecting its scroll-view policy.
                host.layoutSubtreeIfNeeded()
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
                let font = try XCTUnwrap(editor.font)
                let scroll = try XCTUnwrap(editor.enclosingScrollView)
                let lineHeight = NSLayoutManager().defaultLineHeight(for: font)
                let expectedHeight = 3 * lineHeight + 2 * editor.textContainerInset.height
                XCTAssertEqual(scroll.contentSize.height, expectedHeight, accuracy: 1,
                               "\(scheme) \(title): three lines plus native text inset")
                XCTAssertFalse(scroll.hasVerticalScroller, "\(scheme) \(title): Input scrollbar must stay hidden even for long content")
                XCTAssertFalse(scroll.hasHorizontalScroller)
                XCTAssertTrue(editor.isEditable)
                XCTAssertEqual(editor.string, text)
                if text.count > 100 {
                    XCTAssertGreaterThan(editor.frame.height, scroll.contentSize.height,
                                         "Long text must scroll within the same three-line viewport")
                }
                XCTAssertFalse(window.isVisible)
                if let directory = ProcessInfo.processInfo.environment["ADP_IDENTITY_SNAPSHOT_DIR"] {
                    let path = URL(fileURLWithPath: directory)
                    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
                    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        .write(to: path.appendingPathComponent("identity-\(title)-\(scheme).png"))
                }
            }
        }
    }
}
