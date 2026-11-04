import XCTest
import CoreGraphics
@testable import DragonCompanion

@MainActor
final class PetVisibilityTests: XCTestCase {
    private func window(pid: Int32 = 42, width: Double = 384, height: Double = 384, alpha: Double = 1) -> [String: Any] {
        [kCGWindowOwnerPID as String: NSNumber(value: pid),
         kCGWindowAlpha as String: NSNumber(value: alpha),
         kCGWindowBounds as String: CGRect(x: 0, y: 0, width: width, height: height).dictionaryRepresentation]
    }
    func testTransparentPaddingAndMenuSizesAreVisible() {
        for side in [128.0, 192, 256, 384, 480, 576] {
            XCTAssertTrue(WindowGeometry.containsVisibleWindow(pid: 42, windows: [window(width: side, height: side)]))
        }
    }
    func testOtherProcessesDoNotCountAsPet() {
        XCTAssertFalse(WindowGeometry.containsVisibleWindow(pid: 42, windows: [window(pid: 43)]))
    }
    func testInvisibleOrTinyWindowsDoNotCount() {
        XCTAssertFalse(WindowGeometry.containsVisibleWindow(pid: 42, windows: [window(alpha: 0)]))
        XCTAssertFalse(WindowGeometry.containsVisibleWindow(pid: 42, windows: [window(width: 10)]))
        XCTAssertFalse(WindowGeometry.containsVisibleWindow(pid: 42, windows: []))
    }
    func testWindowControlRefusesMissingOrRegularFileSocket() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dragon-window-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertThrowsError(try PetWindowControl.send("hide", pid: 42, directory: root))
        let file = root.appendingPathComponent("dragon-pet-\(getuid())-42.sock")
        try Data().write(to: file)
        XCTAssertThrowsError(try PetWindowControl.send("hide", pid: 42, directory: root))
        XCTAssertThrowsError(try PetWindowControl.send("unknown", pid: 42, directory: root))
    }
}
