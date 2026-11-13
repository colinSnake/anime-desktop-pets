import SwiftUI

/// Shared geometry and contrast for compact workspace actions and search fields.
enum WorkspaceControlStyle {
    static let compactHeight: CGFloat = 26
    static let regularHeight: CGFloat = 34
    static let cornerRadius: CGFloat = 7

    static func borderColor(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.30) : Color.black.opacity(0.22)
    }
}

struct WorkspaceActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme
    var prominent = false
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 11 : 12, weight: .medium))
            .foregroundStyle(prominent ? Color(nsColor: WorkspacePalette.canvas) : Color.primary)
            .padding(.horizontal, 12)
            .frame(height: compact ? WorkspaceControlStyle.compactHeight : WorkspaceControlStyle.regularHeight)
            .background {
                RoundedRectangle(cornerRadius: WorkspaceControlStyle.cornerRadius)
                    .fill(prominent ? Color.primary : Color(nsColor: WorkspacePalette.input))
            }
            .overlay {
                RoundedRectangle(cornerRadius: WorkspaceControlStyle.cornerRadius)
                    .strokeBorder(prominent ? Color.clear : WorkspaceControlStyle.borderColor(for: colorScheme), lineWidth: 1)
            }
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.6)
    }
}
