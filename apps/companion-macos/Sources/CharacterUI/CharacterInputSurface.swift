import AppKit
import SwiftUI

/// Shared chat/identity input chrome. Native editors retain keyboard and IME behavior.
struct CharacterInputSurface: ViewModifier {
    let isFocused: Bool
    var cornerRadius: CGFloat = 10

    func body(content: Content) -> some View {
        content
            .background(CharacterUIStyle.input, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(isFocused ? CharacterBrandStyle.focusGradient : LinearGradient(
                        colors: [CharacterUIStyle.border.opacity(0.7)], startPoint: .leading, endPoint: .trailing
                    ), lineWidth: isFocused ? 1.5 : 1)
                    .allowsHitTesting(false)
            }
            .tint(CharacterBrandStyle.cursor)
    }
}

struct CharacterIdentityEditor: View {
    let title: String
    @Binding var text: String
    @FocusState private var isFocused: Bool

    private var threeLineHeight: CGFloat {
        NSLayoutManager().defaultLineHeight(for: NSFont.preferredFont(forTextStyle: .body)) * 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.body.weight(.medium))
            CharacterTextEditor(text: $text)
                .font(.body)
                .focused($isFocused)
                .scrollContentBackground(.hidden)
                .frame(height: threeLineHeight)
                .padding(10)
                .modifier(CharacterInputSurface(isFocused: isFocused))
                .accessibilityLabel(title)
                .accessibilityIdentifier("identity-editor-\(title)")
                .onExitCommand { isFocused = false }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onDisappear { isFocused = false }
    }
}
