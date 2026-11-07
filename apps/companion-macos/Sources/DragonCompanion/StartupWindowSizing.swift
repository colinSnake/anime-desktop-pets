import AppKit
import ApplicationServices
import DragonCore

/// Only the new launch's matching standard window is resized. No UI text is read.
@MainActor
enum StartupWindowSizing {
    enum Result: String { case requested, accessibilityRequired, unavailable, fullScreen, failed }

    /// Injectable AX boundary: tests use synthetic handles and never message a real application.
    struct Access {
        var trusted: () -> Bool
        var windows: (pid_t) -> [AXUIElement]?
        var frame: (AXUIElement) -> CGRect?
        var fullScreen: (AXUIElement) -> Bool
        var standard: (AXUIElement) -> Bool
        var settable: (AXUIElement) -> Bool
        var resize: (AXUIElement, CGSize) -> Bool
        var move: (AXUIElement, CGPoint) -> Bool

        static let live = Access(trusted: { AXIsProcessTrusted() }, windows: { pid in
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, 0.2)
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success else { return nil }
            guard let windows = value as? [AXUIElement] else { return nil }
            let bounded = Array(windows.prefix(16))
            for window in bounded { AXUIElementSetMessagingTimeout(window, 0.2) }
            return bounded
        }, frame: { StartupWindowSizing.frame(of: $0) }, fullScreen: { window in
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(window, "AXFullScreen" as CFString, &value) == .success
                && (value as? Bool) == true
        }, standard: { window in
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(window, kAXSubroleAttribute as CFString, &value) == .success
                && (value as? String) == (kAXStandardWindowSubrole as String)
        }, settable: { window in
            AXUIElementSetMessagingTimeout(window, 0.2)
            var size = DarwinBoolean(false), position = DarwinBoolean(false)
            return AXUIElementIsAttributeSettable(window, kAXSizeAttribute as CFString, &size) == .success
                && AXUIElementIsAttributeSettable(window, kAXPositionAttribute as CFString, &position) == .success
                && size.boolValue && position.boolValue
        }, resize: { window, size in
            var size = size
            guard let value = AXValueCreate(.cgSize, &size) else { return false }
            return AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) == .success
        }, move: { window, point in
            var point = point
            guard let value = AXValueCreate(.cgPoint, &point) else { return false }
            return AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) == .success
        })
    }

    static func request(pid: pid_t, matching current: NSRect, desired: NSRect,
                        visible: NSRect, primaryTop: Double, access: Access = .live) -> Result {
        // Never prompt for trust during startup, previews, tests or --check.
        guard access.trusted() else { return .accessibilityRequired }
        guard let windows = access.windows(pid) else { return .unavailable }
        let expected = StartupPresentation.flippedFrame(current, primaryTop: primaryTop)
        guard let window = windows.first(where: {
            guard let frame = access.frame($0) else { return false }
            return StartupPresentation.framesMatch(frame, expected, tolerance: 4)
        }) else { return .unavailable }
        if access.fullScreen(window) { return .fullScreen }
        guard access.standard(window), access.settable(window) else { return .unavailable }
        let target = StartupPresentation.flippedFrame(desired, primaryTop: primaryTop)
        guard access.resize(window, target.size) else { return .failed }
        // Respect a client-enforced minimum size. Position the actual result, not the request.
        // Do not attempt a move with stale dimensions if the post-resize AX read failed.
        guard let actual = access.frame(window) else { return .failed }
        let bounds = StartupPresentation.flippedFrame(visible, primaryTop: primaryTop)
        let position = CGPoint(
            x: min(max(target.midX - actual.width / 2, bounds.minX), max(bounds.minX, bounds.maxX - actual.width)),
            y: min(max(target.midY - actual.height / 2, bounds.minY), max(bounds.minY, bounds.maxY - actual.height)))
        guard access.move(window, position) else { return .failed }
        // The caller polls CG again; a successful AX call is not proof of the final frame.
        return .requested
    }

    nonisolated private static func frame(of window: AXUIElement) -> CGRect? {
        var position: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
              let position, let size, CFGetTypeID(position) == AXValueGetTypeID(),
              CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return CGRect(origin: point, size: dimensions)
    }
}
