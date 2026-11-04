import XCTest
import AppKit
import ApplicationServices
@testable import DragonCompanion
import DragonCore

final class StartupWindowSizingTests: XCTestCase {
    @MainActor private func exercise(trusted: Bool = true, available: Bool = true, matches: Bool = true,
                                     fullScreen: Bool = false, standard: Bool = true, settable: Bool = true, resizeOK: Bool = true,
                                     moveOK: Bool = true, minimumSize: CGSize? = nil) -> (StartupWindowSizing.Result, [String], CGRect) {
        // Handles only: no AX call is sent to this or any real process.
        let handle = AXUIElementCreateApplication(0)
        let current = CGRect(x: 20, y: 120, width: 1500, height: 600)
        let visible = CGRect(x: 0, y: 30, width: 1920, height: 1050)
        let desired = StartupPresentation.videoFrame(near: current, visible: visible, maximumWidth: 1280)
        var actual = StartupPresentation.flippedFrame(current, primaryTop: 1080)
        var events: [String] = []
        let access = StartupWindowSizing.Access(trusted: { trusted }, windows: { _ in
            events.append("windows"); return available ? [handle] : nil
        }, frame: { _ in
            matches ? actual : actual.offsetBy(dx: 50, dy: 0)
        }, fullScreen: { _ in fullScreen }, standard: { _ in standard }, settable: { _ in settable }, resize: { _, size in
            events.append("resize")
            if resizeOK { actual.size = minimumSize ?? size }
            return resizeOK
        }, move: { _, point in
            events.append("move")
            if moveOK { actual.origin = point }
            return moveOK
        })
        let result = StartupWindowSizing.request(pid: 0, matching: current, desired: desired,
                                                visible: visible, primaryTop: 1080, access: access)
        return (result, events, StartupPresentation.flippedFrame(actual, primaryTop: 1080))
    }

    @MainActor func testUntrustedDoesNotEvenEnumerateWindowsOrPrompt() async {
        let (result, events, _) = exercise(trusted: false)
        XCTAssertEqual(result, .accessibilityRequired); XCTAssertTrue(events.isEmpty)
    }
    @MainActor func testSuccessfulResizeThenMoveMatchesVideoFrame() async {
        let (result, events, actual) = exercise()
        XCTAssertEqual(result, .requested); XCTAssertEqual(events, ["windows", "resize", "move"])
        XCTAssertEqual(actual.width, 1280); XCTAssertEqual(actual.height, 720)
    }
    @MainActor func testMissingWindowNeverChangesAnything() async {
        let (result, events, _) = exercise(available: false)
        XCTAssertEqual(result, .unavailable); XCTAssertEqual(events, ["windows"])
    }
    @MainActor func testStaleOrWrongWindowIsNotResized() async {
        let (result, events, _) = exercise(matches: false)
        XCTAssertEqual(result, .unavailable); XCTAssertEqual(events, ["windows"])
    }
    @MainActor func testFullScreenIsNotResized() async {
        let (result, events, _) = exercise(fullScreen: true)
        XCTAssertEqual(result, .fullScreen); XCTAssertEqual(events, ["windows"])
    }
    @MainActor func testDialogIsNotResized() async {
        let (result, events, _) = exercise(standard: false)
        XCTAssertEqual(result, .unavailable); XCTAssertEqual(events, ["windows"])
    }
    @MainActor func testFixedWindowIsNotChanged() async {
        let (result, events, _) = exercise(settable: false)
        XCTAssertEqual(result, .unavailable); XCTAssertEqual(events, ["windows"])
    }
    @MainActor func testSizeFailureDoesNotAttemptMove() async {
        let (result, events, _) = exercise(resizeOK: false)
        XCTAssertEqual(result, .failed); XCTAssertEqual(events, ["windows", "resize"])
    }
    @MainActor func testMoveFailureIsNotReportedAsSuccess() async {
        let (result, events, _) = exercise(moveOK: false)
        XCTAssertEqual(result, .failed); XCTAssertEqual(events, ["windows", "resize", "move"])
    }
    @MainActor func testClientMinimumSizeIsRespectedAndClamped() async {
        let (result, _, actual) = exercise(minimumSize: CGSize(width: 1500, height: 900))
        XCTAssertEqual(result, .requested)
        XCTAssertEqual(actual.size, CGSize(width: 1500, height: 900))
        XCTAssertTrue(CGRect(x: 0, y: 30, width: 1920, height: 1050).contains(actual))
    }
    func testLaunchArgumentsOnlyForChromiumFrameworkAndWithoutEditingBundle() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let runtime = Runtime(resources: root, state: root, configuration: .init())
        XCTAssertTrue(runtime.startupLaunchArguments(at: root).isEmpty)
        let framework = root.appendingPathComponent("Contents/Frameworks/Codex Framework.framework")
        try FileManager.default.createDirectory(at: framework, withIntermediateDirectories: true)
        XCTAssertEqual(runtime.startupLaunchArguments(at: root), StartupPresentation.chromiumLaunchArguments)
        XCTAssertTrue((try FileManager.default.contentsOfDirectory(atPath: framework.path)).isEmpty)
    }
}
