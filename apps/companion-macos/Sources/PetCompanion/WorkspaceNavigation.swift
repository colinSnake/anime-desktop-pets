import CharacterUI
import SwiftUI

struct WorkspaceNavigationButton: View {
    @Environment(\.colorScheme) private var colorScheme
    let section: WorkspaceSection
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: section.symbol).frame(width: 16)
                Text(section.rawValue).lineLimit(1)
                Spacer(minLength: 0)
            }
            .font(.system(size: 13, weight: selected ? .semibold : .medium))
            .foregroundStyle(selected ? CharacterBrandStyle.selectionForeground(for: colorScheme) : Color.primary)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 38, maxHeight: 38)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(CharacterBrandStyle.selectionGradient(for: colorScheme))
                        .opacity(colorScheme == .dark ? 0.30 : 0.36)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(section.subtitle)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
