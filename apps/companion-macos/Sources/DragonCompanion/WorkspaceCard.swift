import SwiftUI

struct WorkspaceActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var prominent = false
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 11 : 12, weight: .medium))
            .foregroundStyle(prominent ? Color(nsColor: .windowBackgroundColor) : Color.primary)
            .padding(.horizontal, 12)
            .frame(minHeight: compact ? 26 : 34)
            .background {
                RoundedRectangle(cornerRadius: 7)
                    .fill(prominent ? Color.primary : Color(nsColor: .controlBackgroundColor))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 7)
                    .stroke(Color(nsColor: .separatorColor).opacity(prominent ? 0 : 0.45), lineWidth: 0.5)
            }
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.6)
    }
}
