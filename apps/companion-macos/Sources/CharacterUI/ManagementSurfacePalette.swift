import SwiftUI

/// Semantic surfaces shared by the character UI and its macOS management host.
/// Dynamic NSColors also cover native hosting views and window chrome.
public enum ManagementSurfacePalette {
    public static let canvas = surface("ManagementCanvas", light: .white,
                                       dark: NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1))
    public static let card = surface("ManagementCard",
                                     light: NSColor(srgbRed: 0.965, green: 0.968, blue: 0.975, alpha: 1),
                                     dark: NSColor(srgbRed: 0.17, green: 0.18, blue: 0.20, alpha: 1))
    public static let input = surface("ManagementInput", light: .white,
                                      dark: NSColor(srgbRed: 0.22, green: 0.23, blue: 0.25, alpha: 1))
    public static let border = surface("ManagementBorder",
                                       light: NSColor(srgbRed: 0.86, green: 0.87, blue: 0.90, alpha: 1),
                                       dark: NSColor(srgbRed: 0.30, green: 0.31, blue: 0.34, alpha: 1))

    private static func surface(_ name: String, light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: NSColor.Name(name)) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }
}
