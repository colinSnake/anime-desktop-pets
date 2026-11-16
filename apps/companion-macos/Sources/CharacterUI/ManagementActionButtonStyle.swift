import SwiftUI

/// Shared geometry for workspace actions and inputs (points, not backing pixels).
public enum ManagementControlStyle {
    public static let compactHeight: CGFloat = 26
    public static let regularHeight: CGFloat = 34
    public static let cornerRadius: CGFloat = 7

    public static func borderColor(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.30) : Color.black.opacity(0.22)
    }
}

/// The same action used by the pet page and character forms.
public struct ManagementActionButtonStyle: ButtonStyle {
    private let prominent: Bool
    private let compact: Bool

    public init(prominent: Bool = false, compact: Bool = false) {
        self.prominent = prominent
        self.compact = compact
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label.modifier(ManagementControlSurface(
            prominent: prominent, compact: compact, isPressed: configuration.isPressed
        ))
    }
}

/// A menu label and an action share the same visible surface, not just an outer frame.
struct ManagementControlSurface: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme
    var prominent = false
    var compact = true
    var isPressed = false

    func body(content: Content) -> some View {
        content
            .font(.system(size: compact ? 11 : 12, weight: .medium))
            .foregroundStyle(prominent ? Color(nsColor: ManagementSurfacePalette.canvas) : Color.primary)
            .padding(.horizontal, 12)
            .frame(height: compact ? ManagementControlStyle.compactHeight : ManagementControlStyle.regularHeight)
            .background {
                RoundedRectangle(cornerRadius: ManagementControlStyle.cornerRadius)
                    .fill(prominent ? Color.primary : Color(nsColor: ManagementSurfacePalette.input))
            }
            .overlay {
                RoundedRectangle(cornerRadius: ManagementControlStyle.cornerRadius)
                    .strokeBorder(prominent ? Color.clear : ManagementControlStyle.borderColor(for: colorScheme), lineWidth: 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: ManagementControlStyle.cornerRadius))
            .opacity(isEnabled ? (isPressed ? 0.82 : 1) : 0.6)
    }
}
