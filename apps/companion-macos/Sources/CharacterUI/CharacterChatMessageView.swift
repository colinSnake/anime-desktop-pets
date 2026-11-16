import CharacterCore
import SwiftUI

/// One message and its fixed, local-time metadata. No live clock or extra timer.
struct CharacterChatMessageView: View {
    let turn: CharacterChatTurn

    var body: some View {
        HStack(alignment: .top) {
            if turn.role == .assistant {
                VStack(alignment: .leading, spacing: 4) {
                    bubble(tint: .accentColor)
                    if let time = Self.timestampText(for: turn) {
                        Text(time)
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .padding(.leading, 2)
                            .accessibilityLabel("回复时间 \(time)")
                    }
                }
                Spacer(minLength: 48)
            } else {
                Spacer(minLength: 48)
                bubble(tint: .secondary)
            }
        }
    }

    static func timestampText(for turn: CharacterChatTurn, timeZone: TimeZone = .autoupdatingCurrent) -> String? {
        guard turn.role == .assistant, let date = turn.createdAt else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    private func bubble(tint: Color) -> some View {
        Text(turn.text)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .foregroundStyle(.primary)
            .background(tint.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
