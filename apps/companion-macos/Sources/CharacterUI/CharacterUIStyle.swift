import SwiftUI

enum CharacterUIStyle {
    static let canvas = Color(nsColor: ManagementSurfacePalette.canvas)
    static let cardBackground = Color(nsColor: ManagementSurfacePalette.card)
    static let input = Color(nsColor: ManagementSurfacePalette.input)
    static let border = Color(nsColor: ManagementSurfacePalette.border)
}

public enum CharacterBrandStyle {
    public static let focusGradient = LinearGradient(
        stops: [
            .init(color: Color(red: 0.13, green: 0.81, blue: 0.87), location: 0),
            .init(color: Color(red: 0.62, green: 0.49, blue: 0.84), location: 0.55),
            .init(color: Color(red: 0.96, green: 0.95, blue: 0.99), location: 1),
        ],
        startPoint: .leading,
        endPoint: .trailing
    )

    public static let cursor = Color(red: 0.43, green: 0.32, blue: 0.67)

    public static func selectionGradient(for colorScheme: ColorScheme) -> LinearGradient {
        focusGradient
    }

    public static func selectionForeground(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? Color(red: 0.98, green: 0.97, blue: 1)
            : Color(red: 0.25, green: 0.20, blue: 0.38)
    }
}

struct CharacterSectionHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title2.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
    }
}

struct CharacterActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(configuration.isPressed ? Color.accentColor.opacity(0.72) : Color.accentColor)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
