import Foundation
import CoreGraphics

/// Geometry and launch policy only; never inspects client UI or chat contents.
public enum StartupPresentation {
    public static let aspectRatio = 16.0 / 9.0
    // Chromium's macOS occlusion checker excludes translucent covering windows.
    // Keep the client painting underneath without a perceptible transparent overlay.
    public static let coveringOpacity = 0.999
    public static let chromiumLaunchArguments = ["--disable-backgrounding-occluded-windows"]

    public static func videoFrame(near frame: CGRect?, visible: CGRect, maximumWidth: Double) -> CGRect {
        let width = min(maximumWidth, visible.width * 0.9, visible.height * 0.9 * aspectRatio)
        let height = width / aspectRatio
        let center = frame.map { CGPoint(x: $0.midX, y: $0.midY) }
            ?? CGPoint(x: visible.midX, y: visible.midY)
        return CGRect(x: min(max(center.x - width / 2, visible.minX), visible.maxX - width),
                      y: min(max(center.y - height / 2, visible.minY), visible.maxY - height),
                      width: width, height: height)
    }

    /// AX/CG use the primary display's top edge, not each display's height.
    /// Applying the transform twice converts back, including negative-origin displays.
    public static func flippedFrame(_ frame: CGRect, primaryTop: Double) -> CGRect {
        CGRect(x: frame.minX, y: primaryTop - frame.maxY, width: frame.width, height: frame.height)
    }

    public static func framesMatch(_ a: CGRect, _ b: CGRect, tolerance: Double = 2) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }

    public static func opacity(_ opacity: Double, coveringClient: Bool) -> Double {
        min(opacity, coveringClient ? coveringOpacity : 1)
    }
}
