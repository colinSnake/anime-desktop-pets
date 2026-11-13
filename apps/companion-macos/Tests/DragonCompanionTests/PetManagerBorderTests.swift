import AppKit
import DragonCore
import SwiftUI
import XCTest
@testable import DragonCompanion

@MainActor
final class PetManagerBorderTests: XCTestCase {
    private func snapshot(_ view: NSView, name: String) throws -> NSBitmapImageRep {
        view.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        if let path = ProcessInfo.processInfo.environment["ADP_UI_SNAPSHOT_DIR"] {
            let directory = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: directory.appendingPathComponent("\(name).png"))
        }
        return bitmap
    }

    private func assertBorder(_ view: NSView, label: String,
                              file: StaticString = #filePath, line: UInt = #line) throws {
        let bitmap = try snapshot(view, name: label)
        let scale = CGFloat(bitmap.pixelsWide) / view.bounds.width
        // Orange synthetic covers and neutral controls keep accent detection unambiguous.
        var xs: [Int] = [], ys: [Int] = []
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                let c = try XCTUnwrap(bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
                if c.blueComponent - max(c.redComponent, c.greenComponent) > 0.22,
                   c.blueComponent > 0.55 {
                    xs.append(x); ys.append(y)
                }
            }
        }
        let left = try XCTUnwrap(xs.min()), right = try XCTUnwrap(xs.max())
        let top = try XCTUnwrap(ys.min()), bottom = try XCTUnwrap(ys.max())
        XCTAssertEqual(right - left + 1, Int(160 * scale), label, file: file, line: line)
        let accent = try XCTUnwrap(bitmap.colorAt(x: right, y: (top + bottom) / 2)?.usingColorSpace(.deviceRGB))
        var points: [(Int, Int)] = []
        // Check the full 2pt width along each straight edge, including the cover area.
        // Comparing within the same bitmap avoids differences in native color profiles.
        let corner = Int(14 * scale), step = Int(8 * scale)
        for inset in 0..<Int(2 * scale) {
            for x in stride(from: left + corner, through: right - corner, by: step) {
                points.append((x, top + inset)); points.append((x, bottom - inset))
            }
            for y in stride(from: top + corner, through: bottom - corner, by: step) {
                points.append((left + inset, y)); points.append((right - inset, y))
            }
        }
        var largestError: CGFloat = 0
        for (x, y) in points {
            let c = try XCTUnwrap(bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
            largestError = max(largestError, abs(c.redComponent - accent.redComponent),
                               abs(c.greenComponent - accent.greenComponent), abs(c.blueComponent - accent.blueComponent))
        }
        XCTAssertLessThanOrEqual(largestError, 0.035, "\(label): interrupted or translucent border pixels", file: file, line: line)
    }

    private func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.lazy.compactMap { self.scrollView(in: $0) }.first
    }

    func testCandidateBordersInNativeScrollContainer() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pet-border-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let sources = (0..<18).map {
            LocalPetSource(path: root.appendingPathComponent("pet-\($0)").path, id: "demo.\($0)",
                           version: "1.0.0", name: $0 == 0 ? "唯一龙妹" : "桌宠 \($0)", actionCount: 35, builtin: $0 == 0)
        }
        let context = try XCTUnwrap(CGContext(data: nil, width: 512, height: 512, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(NSColor.systemOrange.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
        let cover = try XCTUnwrap(context.makeImage())
        let manager = try PetManagerWindow(
            runtime: Runtime(resources: root, state: root, configuration: .init()),
            sourceOperation: { _, _ in LocalPetToolReply(ok: true, pets: sources, packages: nil,
                warnings: nil, failures: nil, error: nil) }, loadCover: { _ in cover })
        let window = try XCTUnwrap(manager.window)
        defer { window.close() }
        manager.rescan()
        for _ in 0..<200 where manager.busy || manager.covers.count != sources.count {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertFalse(manager.busy)
        // Cover completion is separate from scan completion.
        for _ in 0..<200 {
            if case .ready? = manager.covers[sources.last!.path] { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        guard case .ready? = manager.covers[sources.last!.path] else { return XCTFail("Missing ready covers") }
        let content = try XCTUnwrap(window.contentView)
        for scheme in [ColorScheme.light, .dark] {
            window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            for width in [580, 700, 900] {
                window.setContentSize(NSSize(width: width, height: 420))
                for single in [true, false] {
                    manager.query = single ? "唯一" : ""
                    manager.selectSource(sources[0].path, modifiers: [])
                    try await Task.sleep(nanoseconds: 50_000_000)
                    let name = "add-\(scheme)-\(width)-\(single ? "single" : "grid")"
                    try assertBorder(content, label: name)
                    XCTAssertFalse(window.isVisible)
                }
            }
        }
        // Scroll a complete row away, then inspect the next first-column card at the viewport top.
        window.setContentSize(NSSize(width: 700, height: 420))
        let card = NSHostingView(rootView: PetManagerSourceCard(source: sources[3], cover: .ready(cover),
            selected: true, busy: false, select: {}, reveal: {}))
        let rowStride = card.fittingSize.height + 12
        for scheme in [ColorScheme.light, .dark] {
            window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            manager.selectSource(sources[3].path, modifiers: [])
            try await Task.sleep(nanoseconds: 50_000_000)
            let scroll = try XCTUnwrap(scrollView(in: content))
            scroll.contentView.scroll(to: NSPoint(x: 0, y: rowStride))
            scroll.reflectScrolledClipView(scroll.contentView)
            try await Task.sleep(nanoseconds: 50_000_000)
            try assertBorder(content, label: "add-\(scheme)-scrolled")
            XCTAssertFalse(window.isVisible)
        }
    }
}
