import AppKit
import CharacterCore
import CharacterMemory
import SwiftUI
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterMemoryLayoutTests: XCTestCase {
    private func native<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        if let found = view as? T { return [found] }
        return view.subviews.flatMap { native(type, in: $0) }
    }

    func testMemoryActionMatchesCompactPetButtonHeight() {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: Button("加入待确认") {}.buttonStyle(ManagementActionButtonStyle(prominent: true, compact: true)))
        XCTAssertEqual(host.fittingSize.height, 26, accuracy: 0.5)
    }

    func testCategoryMenuUsesTheSameVisible26PointSurfaceAsActions() {
        _ = NSApplication.shared
        for kind in [CharacterMemoryKind.fact, .preference, .episode] {
            let host = NSHostingView(rootView: CharacterMemoryCategoryMenu(selection: .constant(kind)))
            XCTAssertEqual(host.fittingSize.height, 26, accuracy: 0.5)
            XCTAssertEqual(host.fittingSize.width, 88, accuracy: 0.5)
        }
    }

    func testComposerAndRecordsSharePageScrollAtShortWindowHeight() async throws {
        try await assertPageScroll(collection: .personal, populated: false, width: 560, height: 360)
    }

    func testKnowledgeAndLongRecordsRemainScrollableInBothThemesAndSizes() async throws {
        for scheme in [ColorScheme.light, .dark] {
            for collection in CharacterMemoryCollection.allCases {
                try await assertPageScroll(collection: collection, populated: true, width: 560, height: 360, scheme: scheme)
                try await assertPageScroll(collection: collection, populated: false, width: 760, height: 520, scheme: scheme)
            }
        }
    }

    private func assertPageScroll(collection: CharacterMemoryCollection, populated: Bool,
                                  width: CGFloat, height: CGFloat, scheme: ColorScheme = .dark) async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("memory-layout-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CharacterMemoryStore(stateDirectory: root, petID: "fixture")
        if populated {
            for index in 0..<8 {
                var record = CharacterMemory(kind: collection == .knowledge ? .knowledge : .preference,
                    text: "第\(index)条合成资料：" + String(repeating: "可核对的长内容。", count: 24), source: "合成验收手册")
                if index % 2 == 0 { record.status = .confirmed }
                try await store.saveMemory(record)
            }
        }
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色", reviewMemories: { _, _ in [] })
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(model.canSaveIdentity)
        let host = NSHostingView(rootView: CharacterMemoryView(model: model, collection: collection).preferredColorScheme(scheme))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        for _ in 0..<8 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(native(NSSegmentedControl.self, in: host).isEmpty,
                      "Collection navigation must use the lightweight tab rail, not a native segmented bezel")
        for popup in native(NSPopUpButton.self, in: host) {
            XCTAssertEqual(popup.frame.height, 26, accuracy: 0.5, "Visible dropdown must match compact actions")
            XCTAssertLessThanOrEqual(popup.frame.width, 96, "Memory category has only two-character labels")
        }
        let editor = try XCTUnwrap(native(NSTextView.self, in: host).first)
        let editorScroll = try XCTUnwrap(editor.enclosingScrollView)
        let pageScroll = editorScroll.enclosingScrollView
        XCTAssertNotNil(pageScroll, "The composer must scroll with the records, not pin above an independently crushed list")
        if let pageScroll {
            let document = try XCTUnwrap(pageScroll.documentView)
            XCTAssertGreaterThanOrEqual(document.frame.height, pageScroll.contentSize.height)
            let overflow = document.frame.height - pageScroll.contentSize.height
            if populated || height <= 360 {
                XCTAssertGreaterThan(overflow, 50)
            }
            // Editors scroll internally, but neither the composer nor the record
            // collection gets another independently constrained viewport.
            for editor in native(NSTextView.self, in: host) {
                XCTAssertTrue(editor.enclosingScrollView?.enclosingScrollView === pageScroll)
            }
            try snapshot(host, name: "\(collection)-\(scheme)-\(Int(width))x\(Int(height))-\(populated ? "records" : "empty")-top")
            if overflow > 0 {
                // Lazy stacks refine estimated row heights as rows become visible.
                // Keep scrolling until the measured extent stabilizes, as a user
                // scrolling to the end would; do not assert against an old estimate.
                for _ in 0..<12 {
                    let currentHeight = try XCTUnwrap(pageScroll.documentView).frame.height
                    pageScroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, currentHeight - pageScroll.contentSize.height)))
                    pageScroll.reflectScrolledClipView(pageScroll.contentView)
                    host.layoutSubtreeIfNeeded()
                    try await Task.sleep(nanoseconds: 20_000_000)
                    let updated = try XCTUnwrap(pageScroll.documentView).frame.height
                    if abs(updated - currentHeight) < 1 { break }
                }
                let finalDocument = try XCTUnwrap(pageScroll.documentView)
                let viewportBottom = pageScroll.contentView.bounds.maxY
                XCTAssertEqual(viewportBottom, finalDocument.frame.height, accuracy: 2, "Last card and bottom inset must be reachable")
                try snapshot(host, name: "\(collection)-\(scheme)-\(Int(width))x\(Int(height))-\(populated ? "records" : "empty")-bottom")
            }
        }
        XCTAssertFalse(window.isVisible)
    }

    private func snapshot(_ view: NSView, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["ADP_MEMORY_SNAPSHOT_DIR"] else { return }
        let directory = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: directory.appendingPathComponent("\(name).png"))
    }
}
