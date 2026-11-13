import AppKit
import CharacterMemory
import CharacterUI
import SwiftUI
import XCTest
@testable import DragonCompanion

@MainActor
final class WorkspaceSurfaceTests: XCTestCase {
    private func pixel(_ color: NSColor, scheme: ColorScheme) throws -> NSColor {
        let host = NSHostingView(rootView: Color(nsColor: color).frame(width: 12, height: 12)
            .environment(\.colorScheme, scheme))
        host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        host.frame.size = host.fittingSize
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        return try XCTUnwrap(bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)?.usingColorSpace(.deviceRGB))
    }

    func testCanvasAndContentSurfacesAreDistinctInBothThemes() throws {
        _ = NSApplication.shared
        for scheme in [ColorScheme.light, .dark] {
            let canvas = try pixel(WorkspacePalette.canvas, scheme: scheme)
            let card = try pixel(WorkspacePalette.card, scheme: scheme)
            let input = try pixel(WorkspacePalette.input, scheme: scheme)
            if scheme == .light {
                XCTAssertEqual(canvas.redComponent, 1, accuracy: 0.01)
                XCTAssertEqual(canvas.greenComponent, 1, accuracy: 0.01)
                XCTAssertEqual(canvas.blueComponent, 1, accuracy: 0.01)
                XCTAssertLessThan(card.redComponent, canvas.redComponent - 0.015)
                XCTAssertEqual(input.redComponent, 1, accuracy: 0.01)
            } else {
                XCTAssertLessThan(canvas.redComponent, 0.25)
                XCTAssertGreaterThan(card.redComponent, canvas.redComponent + 0.03)
                XCTAssertGreaterThan(input.redComponent, card.redComponent + 0.025)
            }
            XCTAssertEqual(canvas.alphaComponent, 1, accuracy: 0.01)
        }
    }

    func testAllManagementPagesRenderOnCanvasWithoutShowingWindow() throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("workspace-surfaces-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let originalTheme = UserDefaults.standard.object(forKey: "workspaceTheme")
        defer {
            if let originalTheme { UserDefaults.standard.set(originalTheme, forKey: "workspaceTheme") }
            else { UserDefaults.standard.removeObject(forKey: "workspaceTheme") }
        }
        let cover = PetCoverSource(directory: nil, isPackage: false,
            fallback: ProcessInfo.processInfo.environment["ADP_UI_COVER_FILE"].map { URL(fileURLWithPath: $0) })
        let instances = [
            WorkspacePetInstance(id: "demo", name: "龙妹", phase: .running, enabled: true,
                isClone: false, error: nil, canControl: true, canClone: true, canDelete: false, cover: cover),
            WorkspacePetInstance(id: "demo-copy", name: "龙妹 · 分身", phase: .stopped, enabled: true,
                isClone: true, error: nil, canControl: true, canClone: true, canDelete: true, cover: cover),
        ]
        let actions = CompanionWorkspaceWindow.Actions(
            petStatus: { "1 / 2 个桌宠运行中" }, petServiceConnected: { true }, petActionTitle: { "隐藏桌宠" },
            petIsVisible: { true }, togglePet: {}, canControlPets: { true }, canTogglePause: { true },
            petInstances: { instances }, toggleInstance: { _ in }, cloneInstance: { _ in }, deleteInstance: { _ in },
            managePets: {}, pauseTitle: { "暂停联动" }, isPaused: { false }, togglePause: {},
            openData: {}, openAccessibility: {}, canManagePets: { true }, canOpenAccessibility: { true }
        )
        for scheme in [ColorScheme.light, .dark] {
            UserDefaults.standard.set((scheme == .dark ? CompanionWorkspaceWindow.Theme.dark : .light).rawValue,
                                      forKey: "workspaceTheme")
            let state = root.appendingPathComponent(scheme == .dark ? "dark" : "light")
            try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
            let models = try ModelManagerWindow(store: ModelProviderStore(stateDirectory: state), offlinePreview: true)
            let speech = try SpeechSettingsWindow(store: SpeechSettingsStore(stateDirectory: state), offlinePreview: true)
            let navigation = CharacterWorkspaceNavigation()
            let character = CharacterWorkspaceController(content:
                CharacterWorkspaceView(store: try CharacterMemoryStore(stateDirectory: state, petID: "demo"),
                    defaultName: "龙妹", capabilities: [], chat: { _, _ in "离线回复" }, navigation: navigation),
                navigation: navigation)
            let controller = CompanionWorkspaceWindow(models: models, speech: speech, character: character, actions: actions)
            let window = try XCTUnwrap(controller.window)
            defer { window.close() }
            let content = try XCTUnwrap(window.contentView)
            XCTAssertEqual(window.backgroundColor, WorkspacePalette.canvas)
            for section in WorkspaceSection.allCases {
                // The preview stays offscreen: drive the same model/host route as sidebar navigation.
                let host = try XCTUnwrap(window.contentViewController as? NSHostingController<WorkspaceShellView>)
                host.rootView.model.select(section)
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.04))
                content.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
                content.cacheDisplay(in: content.bounds, to: bitmap)
                // Compare within the same bitmap's color profile: a standalone hosting view may
                // use a different backing color space than an NSWindow's hosting tree.
                var expected: NSColor?
                // Toolbar, module canvas and detail margin must share the same background.
                for point in [NSPoint(x: 450, y: 12), NSPoint(x: content.bounds.width - 10, y: 160),
                              NSPoint(x: content.bounds.width - 27, y: 350)] {
                    let x = Int(point.x / content.bounds.width * CGFloat(bitmap.pixelsWide))
                    let y = Int(point.y / content.bounds.height * CGFloat(bitmap.pixelsHigh))
                    let actual = try XCTUnwrap(bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
                    if let expected {
                        XCTAssertEqual(actual.redComponent, expected.redComponent, accuracy: 0.025, "\(scheme) \(section)")
                        XCTAssertEqual(actual.greenComponent, expected.greenComponent, accuracy: 0.025, "\(scheme) \(section)")
                        XCTAssertEqual(actual.blueComponent, expected.blueComponent, accuracy: 0.025, "\(scheme) \(section)")
                    } else {
                        if scheme == .light {
                            XCTAssertEqual(actual.redComponent, 1, accuracy: 0.01)
                            XCTAssertEqual(actual.greenComponent, 1, accuracy: 0.01)
                            XCTAssertEqual(actual.blueComponent, 1, accuracy: 0.01)
                        } else {
                            XCTAssertLessThan(actual.redComponent, 0.25)
                            XCTAssertLessThan(actual.greenComponent, 0.25)
                            XCTAssertLessThan(actual.blueComponent, 0.25)
                        }
                        expected = actual
                    }
                }
                XCTAssertFalse(window.isVisible)
                if let path = ProcessInfo.processInfo.environment["ADP_UI_SNAPSHOT_DIR"] {
                    let directory = URL(fileURLWithPath: path).appendingPathComponent("workspace-\(scheme)")
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        .write(to: directory.appendingPathComponent("\(section.rawValue).png"))
                }
            }
        }
    }
}
