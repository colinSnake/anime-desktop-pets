import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest
@testable import DragonCompanion

final class PetCoverLoaderTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pet-cover-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
        return root
    }

    private func image(_ color: NSColor, width: Int = 24, height: Int = 18) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(color.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }

    private func writeAnimation(in root: URL, builtin: Bool = false) throws {
        let file = "assets/idle.gif"
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(
            root.appendingPathComponent(file) as CFURL, UTType.gif.identifier as CFString, 2, nil))
        CGImageDestinationAddImage(destination, try image(.red), nil)
        CGImageDestinationAddImage(destination, try image(.blue), nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let manifest: [String: Any] = builtin
            ? ["idle": ["file": file]]
            : ["defaultAction": "idle", "actions": [["id": "idle", "file": file]]]
        try JSONSerialization.data(withJSONObject: manifest)
            .write(to: root.appendingPathComponent(builtin ? "素材清单.json" : "manifest.json"))
    }

    private func assertFirstFrame(_ result: CGImage?, file: StaticString = #filePath, line: UInt = #line) throws {
        let bitmap = NSBitmapImageRep(cgImage: try XCTUnwrap(result, file: file, line: line))
        let color = try XCTUnwrap(bitmap.colorAt(x: 1, y: 1)?.usingColorSpace(.deviceRGB), file: file, line: line)
        XCTAssertGreaterThan(color.redComponent, 0.9, file: file, line: line)
        XCTAssertLessThan(color.blueComponent, 0.1, file: file, line: line)
    }

    func testPackageAndBuiltinExtractFirstFrameReadOnly() async throws {
        for builtin in [false, true] {
            let root = try fixture()
            defer { try? FileManager.default.removeItem(at: root) }
            try writeAnimation(in: root, builtin: builtin)
            let before = try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted()
            let loader = PetCoverLoader()
            let result = await loader.image(for: .init(directory: root, isPackage: !builtin, fallback: nil))
            try assertFirstFrame(result)
            XCTAssertEqual(try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted(), before)
        }
    }

    func testPreparedCoverAndMissingCoverCacheCanBeRefreshed() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let source = PetCoverSource(directory: root, isPackage: true, fallback: nil)
        let loader = PetCoverLoader()
        let missing = await loader.image(for: source)
        XCTAssertNil(missing)
        let url = root.appendingPathComponent("workspace-cover.png")
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try image(.red, width: 1000, height: 800), nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let cachedMissing = await loader.image(for: source)
        XCTAssertNil(cachedMissing)
        let refreshed = await loader.image(for: source, refresh: true)
        XCTAssertEqual(refreshed?.width, 512)
        try assertFirstFrame(refreshed)
        let compact = await loader.image(for: .init(directory: root, isPackage: true, fallback: nil, maximumPixelSize: 256))
        XCTAssertEqual(compact?.width, 256)
    }

    func testUnsafeManifestAndAnimationPathsUseFallbackWithoutReadingOutsideDirectory() async throws {
        let root = try fixture()
        let outside = try fixture()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }
        try writeAnimation(in: outside)
        let loader = PetCoverLoader()
        let source = PetCoverSource(directory: root, isPackage: true, fallback: nil)
        let manifest = root.appendingPathComponent("manifest.json")
        try FileManager.default.createSymbolicLink(at: manifest, withDestinationURL: outside.appendingPathComponent("manifest.json"))
        let linkedManifest = await loader.image(for: source)
        XCTAssertNil(linkedManifest)
        try FileManager.default.removeItem(at: manifest)
        for path in ["../assets/idle.gif", outside.appendingPathComponent("assets/idle.gif").path, "assets/link.gif"] {
            try JSONSerialization.data(withJSONObject: ["defaultAction": "idle", "actions": [["id": "idle", "file": path]]])
                .write(to: manifest)
            if path == "assets/link.gif" {
                try FileManager.default.createSymbolicLink(at: root.appendingPathComponent(path),
                                                           withDestinationURL: outside.appendingPathComponent("assets/idle.gif"))
            }
            let result = await loader.image(for: source, refresh: true)
            XCTAssertNil(result)
        }
    }

    func testArchiveThumbnailReadsOnlyDefaultClipWithoutImporting() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeAnimation(in: root)
        let archive = root.appendingPathComponent("synthetic.petpack")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        process.currentDirectoryURL = root
        process.arguments = ["-q", archive.path, "manifest.json", "assets/idle.gif"]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        let before = try Data(contentsOf: archive)
        let loader = PetCoverLoader()
        let result = await loader.image(for: .init(directory: archive, isPackage: true, fallback: nil))
        try assertFirstFrame(result)
        XCTAssertEqual(try Data(contentsOf: archive), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("PetLibrary").path))
    }

    func testArchiveRejectsUnsafeMemberAndOversizedMetadata() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let loader = PetCoverLoader()
        for (index, member) in ["../outside.gif", "assets/*.gif", "assets/../outside.gif"].enumerated() {
            let manifest: [String: Any] = ["defaultAction": "idle", "actions": [["id": "idle", "file": member]]]
            try JSONSerialization.data(withJSONObject: manifest).write(to: root.appendingPathComponent("manifest.json"))
            let archive = root.appendingPathComponent("unsafe-\(index).petpack")
            try zipManifest(in: root, to: archive)
            let result = await loader.image(for: .init(directory: archive, isPackage: true, fallback: nil))
            XCTAssertNil(result)
        }
        try Data(repeating: 32, count: 1024 * 1024 + 1).write(to: root.appendingPathComponent("manifest.json"))
        let archive = root.appendingPathComponent("oversized.petpack")
        try zipManifest(in: root, to: archive)
        let result = await loader.image(for: .init(directory: archive, isPackage: true, fallback: nil))
        XCTAssertNil(result)
    }

    private func zipManifest(in root: URL, to archive: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        process.currentDirectoryURL = root
        process.arguments = ["-q", archive.path, "manifest.json"]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
    }

    @MainActor
    func testSelectedBorderKeepsItsWidthWhenClippedAtScrollContentEdges() throws {
        // Model the scroll viewport: no space outside the card is available for its stroke.
        let source = LocalPetSource(path: "/synthetic", id: "synthetic", version: "1.0.0",
                                    name: "边缘描边", actionCount: 35, builtin: false)
        // Sample the reference through the same renderer to account for display color profiles.
        let reference = ImageRenderer(content: Color(nsColor: WorkspacePalette.accent).frame(width: 4, height: 4))
        let accent = try XCTUnwrap(NSBitmapImageRep(cgImage: XCTUnwrap(reference.cgImage))
            .colorAt(x: 1, y: 1)?.usingColorSpace(.deviceRGB))
        for scheme in [ColorScheme.light, .dark] {
            let renderer = ImageRenderer(content:
                PetManagerSourceCard(source: source, cover: .unavailable, selected: true,
                                     busy: false, select: {}, reveal: {})
                    .clipped()
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, scheme)
            )
            renderer.scale = 2
            let rendered = try XCTUnwrap(renderer.cgImage)
            let bitmap = NSBitmapImageRep(cgImage: rendered)
            // A 1.5pt border must retain at least two fully covered pixels at 2x on all sides.
            let points = [NSPoint(x: 1, y: 80), NSPoint(x: rendered.width - 2, y: 80),
                          NSPoint(x: 160, y: 1), NSPoint(x: 160, y: rendered.height - 2)]
            for point in points {
                let pixel = try XCTUnwrap(bitmap.colorAt(x: Int(point.x), y: Int(point.y))?.usingColorSpace(.deviceRGB))
                XCTAssertEqual(pixel.redComponent, accent.redComponent, accuracy: 0.04, "\(scheme) at \(point)")
                XCTAssertEqual(pixel.greenComponent, accent.greenComponent, accuracy: 0.04, "\(scheme) at \(point)")
                XCTAssertEqual(pixel.blueComponent, accent.blueComponent, accuracy: 0.04, "\(scheme) at \(point)")
                XCTAssertEqual(pixel.alphaComponent, 1, accuracy: 0.01)
            }
            if let path = ProcessInfo.processInfo.environment["ADP_UI_SNAPSHOT_DIR"] {
                let directory = URL(fileURLWithPath: path, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: directory.appendingPathComponent("card-\(scheme)-clipped-border.png"))
            }
        }
    }

    @MainActor
    func testCardRendersReadyLoadingAndUnavailableInBothThemes() throws {
        _ = NSApplication.shared
        let source = LocalPetSource(path: "/synthetic", id: "synthetic", version: "1.0.0",
                                    name: "很长的演示桌宠名字", actionCount: 35, builtin: false)
        var readyImage = try image(.systemPurple)
        if let path = ProcessInfo.processInfo.environment["ADP_UI_COVER_FILE"],
           let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
           let file = CGImageSourceCreateWithData(data as CFData, nil),
           let frame = CGImageSourceCreateImageAtIndex(file, 0, nil) { readyImage = frame }
        let frames: [(String, PetSourceCoverState)] = [("ready", .ready(readyImage)),
                                                      ("loading", .loading), ("unavailable", .unavailable),
                                                      ("long-version", .ready(readyImage))]
        for scheme in [ColorScheme.light, .dark] {
            for (name, state) in frames {
                let cardSource = name == "long-version"
                    ? LocalPetSource(path: "/synthetic", id: "synthetic", version: "1.0.0-rc.20261112",
                                     name: "长版本号桌宠", actionCount: 128, builtin: false)
                    : source
                let renderer = ImageRenderer(content:
                    PetManagerSourceCard(source: cardSource, cover: state, selected: name == "ready",
                                         busy: name == "loading", select: {}, reveal: {})
                        .padding(4)
                        .background(Color(nsColor: .windowBackgroundColor))
                        .environment(\.colorScheme, scheme)
                )
                let rendered = try XCTUnwrap(renderer.cgImage)
                XCTAssertEqual(rendered.width, 168)
                XCTAssertGreaterThan(rendered.height, 170)
                XCTAssertLessThan(rendered.height, 240)
                if let path = ProcessInfo.processInfo.environment["ADP_UI_SNAPSHOT_DIR"] {
                    let directory = URL(fileURLWithPath: path, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let bitmap = NSBitmapImageRep(cgImage: rendered)
                    try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        .write(to: directory.appendingPathComponent("card-\(scheme)-\(name).png"))
                }
            }
        }
    }
}
