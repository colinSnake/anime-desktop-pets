import SwiftUI

/// A native editable field with the same outer bounds and border as compact actions.
struct WorkspaceSearchField: View {
    let prompt: String
    @Binding var text: String
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled
    @FocusState private var focused: Bool

    var body: some View {
        TextField(prompt, text: $text)
            .textFieldStyle(.plain)
            .font(.system(size: 12))
            // Keep the native text line at its natural height inside the 26pt shell.
            // At 11pt, macOS can size the idle field one point shorter than its editor.
            .fixedSize(horizontal: false, vertical: true)
            .focused($focused)
            .padding(.horizontal, 8)
            .frame(height: WorkspaceControlStyle.compactHeight)
            .background(Color(nsColor: WorkspacePalette.input),
                        in: RoundedRectangle(cornerRadius: WorkspaceControlStyle.cornerRadius))
            .overlay {
                RoundedRectangle(cornerRadius: WorkspaceControlStyle.cornerRadius)
                    .strokeBorder(focused ? Color(nsColor: WorkspacePalette.accent)
                                          : WorkspaceControlStyle.borderColor(for: colorScheme), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .opacity(isEnabled ? 1 : 0.6)
            .accessibilityLabel(prompt)
    }
}
