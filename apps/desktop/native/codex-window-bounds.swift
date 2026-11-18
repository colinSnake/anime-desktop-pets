import AppKit
import CoreGraphics

// Only the fixed installed client is eligible. Do not prompt for screen capture or AX permission.
guard CommandLine.arguments.count == 1 else { exit(64) }
let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
    .filter { !$0.isTerminated && !$0.isHidden && $0.activationPolicy == .regular }
guard candidates.count == 1, let client = candidates.first,
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
else { exit(0) }

var match: CGRect?
for info in windows {
    guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == client.processIdentifier,
          (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha > 0.05, alpha <= 1,
          let bounds = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
          [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy(\.isFinite),
          rect.width >= 320, rect.height >= 200
    else { continue }
    // Do not guess which of several normal windows belongs to the launch.
    if match != nil { exit(0) }
    match = rect
}
guard let rect = match, !client.isTerminated, !client.isHidden else { exit(0) }
// Quartz window bounds use a top-left screen origin. Round inwards, not into another screen.
let x = ceil(rect.minX), y = ceil(rect.minY)
let width = floor(rect.maxX) - x, height = floor(rect.maxY) - y
guard abs(x) <= 131072, abs(y) <= 131072, width >= 320, height >= 200, width <= 16384, height <= 16384
else { exit(0) }
print("v1 \(Int(x)) \(Int(y)) \(Int(width)) \(Int(height))")
