import AppKit
import CoreGraphics

@MainActor
enum WindowGeometry {
    static func codexWindow(pid: pid_t) -> NSRect? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        return windows.compactMap { info -> NSRect? in
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0.05,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 300, rect.height > 180 else { return nil }
            return NSRect(x: rect.minX, y: primaryTop - rect.maxY, width: rect.width, height: rect.height)
        }.max { $0.width * $0.height < $1.width * $1.height }
    }

    static func hasVisibleWindow(pid: pid_t) -> Bool {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        return containsVisibleWindow(pid: pid, windows: windows)
    }

    static func containsVisibleWindow(pid: pid_t, windows: [[String: Any]]) -> Bool {
        windows.contains { info in
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0.05,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return rect.width >= 48 && rect.height >= 48
        }
    }

    static func screen(for rect: NSRect?) -> NSScreen? {
        guard let rect else { return NSScreen.main ?? NSScreen.screens.first }
        return NSScreen.screens.max {
            let a = $0.frame.intersection(rect), b = $1.frame.intersection(rect)
            return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
        }
    }

    static func fullscreenOtherApp(on screen: NSScreen) -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != getpid(),
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let target = CGRect(x: screen.frame.minX, y: primaryTop - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
        return windows.contains { w in
            guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == front.processIdentifier,
                  (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let bounds = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return rect.minX <= target.minX + 2 && rect.minY <= target.minY + 2 && rect.maxX >= target.maxX - 2 && rect.maxY >= target.maxY - 2
        }
    }
}
