import SwiftUI

struct WorkspaceNavigationButton: View {
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
            .foregroundStyle(selected ? Color.white : Color.primary)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 38, maxHeight: 38)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 7).fill(
                        LinearGradient(colors: [Color(red: 0.56, green: 0.43, blue: 0.87),
                                                Color(red: 0.70, green: 0.53, blue: 0.91)],
                                       startPoint: .leading, endPoint: .trailing)
                    )
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(section.subtitle)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
