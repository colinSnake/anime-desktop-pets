import AppKit
import SwiftUI
import XCTest
@testable import DragonCompanion

@MainActor
final class WorkspacePresentationTests: XCTestCase {
    func testCompactButtonHeightMatchesAcrossThemesAndStates() {
        _ = NSApplication.shared
        for theme in [ColorScheme.light, .dark] {
            for disabled in [false, true] {
                for prominent in [false, true] {
                    for title in ["选择素材目录", "刷新", "添加", "查看目录"] {
                        let host = NSHostingView(rootView:
                            Button(title) {}
                                .buttonStyle(WorkspaceActionButtonStyle(prominent: prominent, compact: true))
                                .disabled(disabled)
                                .environment(\.colorScheme, theme)
                        )
                        XCTAssertEqual(host.fittingSize.height, 26, accuracy: 0.5, title)
                    }
                }
            }
        }
        let regular = NSHostingView(rootView:
            Button("普通操作") {}.buttonStyle(WorkspaceActionButtonStyle())
        )
        XCTAssertEqual(regular.fittingSize.height, 34, accuracy: 0.5)
    }

    func testSearchAndPetPageAddMatchCompactActionHeight() {
        _ = NSApplication.shared
        for theme in [ColorScheme.light, .dark] {
            for disabled in [false, true] {
                for text in ["", "龙妹"] {
                    let field = NSHostingView(rootView:
                        WorkspaceSearchField(prompt: "搜索名称、版本或路径", text: .constant(text))
                            .frame(width: 250).disabled(disabled)
                            .environment(\.colorScheme, theme)
                    )
                    XCTAssertEqual(field.fittingSize.height, 26, accuracy: 0.5)
                }
                let add = NSHostingView(rootView:
                    Button {} label: { Label("添加桌宠", systemImage: "plus") }
                        .buttonStyle(WorkspaceActionButtonStyle(compact: true))
                        .disabled(disabled).environment(\.colorScheme, theme)
                )
                XCTAssertEqual(add.fittingSize.height, 26, accuracy: 0.5)
            }
        }
    }

    func testCompactActionBorderRemainsVisibleInBothThemes() throws {
        for theme in [ColorScheme.light, .dark] {
            let renderer = ImageRenderer(content:
                Button("刷新") {}.buttonStyle(WorkspaceActionButtonStyle(compact: true))
                    .environment(\.colorScheme, theme)
            )
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage)
            let bitmap = NSBitmapImageRep(cgImage: image)
            let edge = try XCTUnwrap(bitmap.colorAt(x: 0, y: image.height / 2)?.usingColorSpace(.deviceRGB))
            let surface = try XCTUnwrap(bitmap.colorAt(x: 5, y: image.height / 2)?.usingColorSpace(.deviceRGB))
            let difference = abs(edge.redComponent - surface.redComponent)
                + abs(edge.greenComponent - surface.greenComponent)
                + abs(edge.blueComponent - surface.blueComponent)
            XCTAssertGreaterThan(difference / 3, 0.12, "\(theme) border should be distinct from its surface")
            XCTAssertEqual(edge.alphaComponent, 1, accuracy: 0.01)

            if let path = ProcessInfo.processInfo.environment["ADP_UI_SNAPSHOT_DIR"] {
                let preview = NSHostingView(rootView:
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 7) {
                            Button("选择素材目录") {}
                            Button("刷新") {}
                            WorkspaceSearchField(prompt: "搜索名称、版本或路径", text: .constant(""))
                                .frame(width: 220)
                            Button("添加") {}
                                .buttonStyle(WorkspaceActionButtonStyle(prominent: true, compact: true))
                        }
                        Button {} label: { Label("添加桌宠", systemImage: "plus") }
                        HStack(spacing: 7) {
                            Button("刷新") {}.disabled(true)
                            WorkspaceSearchField(prompt: "正在扫描…", text: .constant(""))
                                .frame(width: 220).disabled(true)
                            Button("添加") {}
                                .buttonStyle(WorkspaceActionButtonStyle(prominent: true, compact: true))
                                .disabled(true)
                        }
                    }
                    .buttonStyle(WorkspaceActionButtonStyle(compact: true))
                    .padding(16).background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, theme)
                )
                preview.appearance = NSAppearance(named: theme == .dark ? .darkAqua : .aqua)
                preview.frame.size = preview.fittingSize
                preview.layoutSubtreeIfNeeded()
                let directory = URL(fileURLWithPath: path, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let snapshot = try XCTUnwrap(preview.bitmapImageRepForCachingDisplay(in: preview.bounds))
                preview.cacheDisplay(in: preview.bounds, to: snapshot)
                try XCTUnwrap(snapshot.representation(using: .png, properties: [:]))
                    .write(to: directory.appendingPathComponent("compact-controls-\(theme).png"))
            }
        }
    }

    func testNavigationSelectionNotifiesHostAndKeepsSelectedSection() {
        let model = WorkspaceShellModel(section: .pets)
        var selectedByHost: WorkspaceSection?
        model.onSelect = { selectedByHost = $0 }

        model.select(.live)

        XCTAssertEqual(selectedByHost, .live)
        XCTAssertEqual(model.selected, .live)
        XCTAssertEqual(WorkspaceSection.allCases.count, 9)
    }

    func testThemeCyclesAndPersistsWithoutChangingSystemDefault() {
        let defaults = UserDefaults.standard
        let key = "workspaceTheme"
        let original = defaults.object(forKey: key)
        defer {
            if let original { defaults.set(original, forKey: key) }
            else { defaults.removeObject(forKey: key) }
        }
        defaults.set(CompanionWorkspaceWindow.Theme.system.rawValue, forKey: key)
        let model = WorkspaceShellModel(section: .pets)
        var appliedTheme: CompanionWorkspaceWindow.Theme?
        model.onThemeChanged = { appliedTheme = $0 }

        model.cycleTheme()

        XCTAssertEqual(model.theme, .dark)
        XCTAssertEqual(appliedTheme, .dark)
        XCTAssertEqual(defaults.integer(forKey: key), CompanionWorkspaceWindow.Theme.dark.rawValue)
        XCTAssertEqual(CompanionWorkspaceWindow.Theme.system.preferredColorScheme, nil)
        XCTAssertEqual(CompanionWorkspaceWindow.Theme.dark.preferredColorScheme, .dark)
        XCTAssertEqual(CompanionWorkspaceWindow.Theme.light.preferredColorScheme, .light)
    }

    func testActionPageRefreshesRowsAndOnlyRunsEnabledActions() {
        var enabled = false
        var runs = 0
        var status = "离线"
        let action = WorkspaceActionPageController.Action(
            "系统操作", symbol: "folder", run: { runs += 1 },
            enabled: { enabled }, isOn: { enabled }, isToggle: true
        )
        let model = WorkspaceActionPageModel(
            title: "高级", accent: .systemPurple, status: { status },
            actionTitle: "权限", actions: [action]
        )

        XCTAssertEqual(model.status, "离线")
        XCTAssertEqual(model.rows.count, 1)
        XCTAssertFalse(model.rows[0].enabled)
        XCTAssertTrue(model.rows[0].isToggle)
        model.perform(0)
        XCTAssertEqual(runs, 0)

        enabled = true
        status = "可用"
        model.refresh()
        XCTAssertTrue(model.rows[0].enabled)
        XCTAssertTrue(model.rows[0].isOn)
        XCTAssertEqual(model.status, "可用")
        model.perform(0)
        XCTAssertEqual(runs, 1)
    }
}
