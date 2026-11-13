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
                    let host = NSHostingView(rootView:
                        Button("添加") {}
                            .buttonStyle(WorkspaceActionButtonStyle(prominent: prominent, compact: true))
                            .disabled(disabled)
                            .environment(\.colorScheme, theme)
                    )
                    XCTAssertEqual(host.fittingSize.height, 26, accuracy: 0.5)
                }
            }
        }
        let regular = NSHostingView(rootView:
            Button("普通操作") {}.buttonStyle(WorkspaceActionButtonStyle())
        )
        XCTAssertEqual(regular.fittingSize.height, 34, accuracy: 0.5)
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
