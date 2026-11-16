import AppKit
import SwiftUI

/// Empty-chat identity only; the decorative mark is not an app icon or a control.
struct CharacterChatWelcomeView: View {
    let name: String

    // Load the bundled SVG explicitly and let SwiftUI tint its vector silhouette.
    private static let mark = Bundle.module.url(forResource: "chat-welcome-mark", withExtension: "svg")
        .flatMap { NSImage(contentsOf: $0) }

    var body: some View {
        HStack(spacing: 12) {
            if let mark = Self.mark {
                Image(nsImage: mark)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 40, height: 40)
                    .accessibilityHidden(true)
            }
            Text("今天想和\(name)聊点什么？")
                .font(.largeTitle.weight(.semibold))
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(.primary)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
