import AppKit
import XCTest
@testable import PetCompanion

@MainActor
final class PetDeletionConfirmationTests: XCTestCase {
    func testConfirmationUsesConciseButtonsAndNoSecondaryDescription() {
        _ = NSApplication.shared
        let alert = PetDeletionConfirmation.makeAlert()
        XCTAssertEqual(alert.messageText, "")
        XCTAssertEqual(alert.informativeText, "")
        XCTAssertEqual(alert.buttons.map(\.title), ["确认", "取消"])
    }

    func testApplicationLogoActuallyRendersInSheetInBothThemes() async throws {
        _ = NSApplication.shared
        let originalIcon = NSApp.applicationIconImage
        defer { NSApp.applicationIconImage = originalIcon }
        // A distinctive application icon detects AppKit omitting it from the sheet,
        // unlike merely asserting that NSAlert.icon has a non-nil default value.
        NSApp.applicationIconImage = NSImage(size: NSSize(width: 64, height: 64), flipped: false) { rect in
            NSColor(deviceRed: 1, green: 0, blue: 1, alpha: 1).setFill()
            rect.fill()
            return true
        }
        for appearanceName in [NSAppearance.Name.aqua, .darkAqua] {
            let parent = makeOffscreenParent()
            parent.appearance = NSAppearance(named: appearanceName)
            let confirmation = PetDeletionConfirmation()
            defer { confirmation.dismiss(); parent.close() }
            confirmation.present(in: parent) { XCTFail("Rendering must not delete an instance") }
            let alert = try XCTUnwrap(confirmation.alert)
            alert.window.alphaValue = 0
            let content = try XCTUnwrap(alert.window.contentView)
            content.layoutSubtreeIfNeeded()
            let accessory = try XCTUnwrap(alert.accessoryView)
            XCTAssertEqual(accessory.frame.size, NSSize(width: 220, height: 44))
            XCTAssertEqual(accessory.superview?.frame.minX ?? -1, 20, accuracy: 1)
            XCTAssertGreaterThanOrEqual(accessory.superview?.frame.maxY ?? 0, content.bounds.maxY - 20,
                                         "The logo and title row should sit at the top of the alert")
            let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
            content.cacheDisplay(in: content.bounds, to: bitmap)
            if let path = ProcessInfo.processInfo.environment["ADP_UI_SNAPSHOT_DIR"] {
                let directory = URL(fileURLWithPath: path, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: directory.appendingPathComponent("delete-\(appearanceName.rawValue).png"))
            }
            var logoPixels = 0
            var logoBounds: CGRect?
            for y in 0..<bitmap.pixelsHigh {
                for x in 0..<bitmap.pixelsWide {
                    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                    // Allow display-profile conversion to lift the magenta green channel.
                    guard color.redComponent > 0.8 && color.greenComponent < 0.45 && color.blueComponent > 0.8 else { continue }
                    logoPixels += 1
                    let point = CGRect(x: x, y: y, width: 1, height: 1)
                    logoBounds = logoBounds.map { $0.union(point) } ?? point
                }
            }
            XCTAssertGreaterThan(logoPixels, 100, "The application logo must remain visible in \(appearanceName)")
            let bounds = try XCTUnwrap(logoBounds)
            XCTAssertLessThanOrEqual(bounds.width, 72, "The logo should be smaller than the previous 64pt mark")
            XCTAssertLessThanOrEqual(bounds.height, 72, "The logo should be smaller than the previous 64pt mark")
            XCTAssertLessThan(bounds.minX, 100, "The logo should sit at the upper-left of the alert content")
        }
    }

    func testConfirmationDisablesAutoHideWithoutShowingWindow() {
        _ = NSApplication.shared
        let alert = PetDeletionConfirmation.makeAlert()
        XCTAssertFalse(alert.window.hidesOnDeactivate)
        XCTAssertFalse(alert.window.isVisible, "Building the alert must not display it or steal focus")
    }

    private func makeOffscreenParent() -> NSWindow {
        _ = NSApplication.shared
        let parent = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 700, height: 420),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        parent.isReleasedWhenClosed = false
        parent.alphaValue = 0
        return parent
    }

    private func waitForCompletion(_ confirmation: PetDeletionConfirmation) async throws {
        for _ in 0..<200 where confirmation.alert != nil {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertNil(confirmation.alert)
    }

    func testSheetBelongsToWorkspaceAndInheritsBothThemes() async throws {
        for appearanceName in [NSAppearance.Name.aqua, .darkAqua] {
            let parent = makeOffscreenParent()
            parent.appearance = NSAppearance(named: appearanceName)
            let confirmation = PetDeletionConfirmation()
            defer { confirmation.dismiss(); parent.close() }
            var deleted = 0
            confirmation.present(in: parent) { deleted += 1 }
            let alert = try XCTUnwrap(confirmation.alert)
            alert.window.alphaValue = 0
            XCTAssertTrue(parent.attachedSheet === alert.window)
            XCTAssertTrue(alert.window.sheetParent === parent)
            XCTAssertEqual(alert.window.appearance?.name, appearanceName)
            XCTAssertFalse(alert.window.hidesOnDeactivate)
            XCTAssertEqual(parent.alphaValue, 0, "AppKit orders sheet parents in; keep the test window transparent")
            confirmation.dismiss()
            try await Task.sleep(nanoseconds: 20_000_000)
            XCTAssertNil(confirmation.alert)
            XCTAssertEqual(deleted, 0, "Application shutdown must cancel, not confirm deletion")
        }
    }

    func testOnlyConfirmationInvokesDeletionAndDuplicatePresentationIsIgnored() async throws {
        for response in [NSApplication.ModalResponse.alertFirstButtonReturn, .alertSecondButtonReturn, .cancel] {
            let parent = makeOffscreenParent()
            let confirmation = PetDeletionConfirmation()
            defer { confirmation.dismiss(); parent.close() }
            var deleted = 0
            confirmation.present(in: parent) { deleted += 1 }
            let alert = try XCTUnwrap(confirmation.alert)
            alert.window.alphaValue = 0
            confirmation.present(in: parent) { deleted += 100 }
            XCTAssertTrue(confirmation.alert === alert)
            parent.endSheet(alert.window, returnCode: response)
            try await waitForCompletion(confirmation)
            XCTAssertEqual(deleted, response == .alertFirstButtonReturn ? 1 : 0)
        }
    }

    func testAnotherAttachedSheetIsNotReplaced() throws {
        let parent = makeOffscreenParent()
        let first = PetDeletionConfirmation()
        let second = PetDeletionConfirmation()
        defer { first.dismiss(); second.dismiss(); parent.close() }
        first.present(in: parent) { XCTFail("The existing sheet must not confirm automatically") }
        let alert = try XCTUnwrap(first.alert)
        alert.window.alphaValue = 0
        second.present(in: parent) { XCTFail("A blocked second sheet must not delete anything") }
        XCTAssertNil(second.alert)
        XCTAssertTrue(parent.attachedSheet === alert.window)
    }
}
