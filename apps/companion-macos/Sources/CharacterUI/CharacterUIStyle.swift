import SwiftUI

enum CharacterUIStyle {
    static let cardBackground = Color(nsColor: NSColor(name: NSColor.Name("CharacterCardBackground")) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(calibratedWhite: 0.21, alpha: 1)
            : NSColor(calibratedWhite: 0.99, alpha: 1)
    })
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
