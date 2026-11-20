import AppKit
import CoreGraphics

// Match the existing geometry-based Qt policy. Return one bit; no names,
// identifiers, frames, screen contents or permission requests leave this helper.
guard CommandLine.arguments.count == 1 else { exit(64) }
guard let front = NSWorkspace.shared.frontmostApplication else { exit(0) }
var displays = [CGDirectDisplayID](repeating: 0, count: 32)
var count: UInt32 = 0
guard CGGetActiveDisplayList(UInt32(displays.count), &displays, &count) == .success, count > 0,
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
else { exit(0) }
let screens = displays.prefix(Int(count)).map(CGDisplayBounds)
let fullscreen = windows.contains { info in
    guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == front.processIdentifier,
          (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha > 0.05,
          let bounds = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
          [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite), rect.width >= 100, rect.height >= 100
    else { return false }
    return screens.contains { rect.minX <= $0.minX + 2 && rect.minY <= $0.minY + 2 &&
        rect.maxX >= $0.maxX - 2 && rect.maxY >= $0.maxY - 2 }
}
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == front.processIdentifier else { exit(0) }
print(fullscreen ? "v1 1" : "v1 0")
