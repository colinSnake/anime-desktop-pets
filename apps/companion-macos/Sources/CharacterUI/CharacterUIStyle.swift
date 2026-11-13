import SwiftUI

enum CharacterUIStyle {
    static let canvas = Color(nsColor: ManagementSurfacePalette.canvas)
    static let cardBackground = Color(nsColor: ManagementSurfacePalette.card)
    static let input = Color(nsColor: ManagementSurfacePalette.input)
    static let border = Color(nsColor: ManagementSurfacePalette.border)
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
