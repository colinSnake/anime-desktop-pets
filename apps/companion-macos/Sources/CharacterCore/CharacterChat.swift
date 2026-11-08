import Foundation

public enum CharacterChatRole: String, Codable, Sendable {
    case user
    case assistant
}

public struct CharacterChatTurn: Codable, Equatable, Sendable {
    public let role: CharacterChatRole
    public let text: String

    public init(role: CharacterChatRole, text: String) {
        self.role = role
        self.text = text
    }
}

/// An in-memory transcript for one chat window. It is deliberately bounded and
/// is never written to the character Markdown store.
public struct CharacterChatSession: Equatable, Sendable {
    public static let maxTurns = 12
    public static let maxCharacters = 6_000
    public static let maxTextCharacters = 1_200

    public static func validatedInput(_ rawText: String) -> String? {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= maxTextCharacters else { return nil }
        return text
    }

    public private(set) var turns: [CharacterChatTurn]

    public init(turns: [CharacterChatTurn] = []) {
        self.turns = []
        for turn in turns {
            append(turn)
        }
    }

    public mutating func append(role: CharacterChatRole, text: String) {
        append(CharacterChatTurn(role: role, text: text))
    }

    public mutating func append(_ turn: CharacterChatTurn) {
        let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        turns.append(CharacterChatTurn(role: turn.role, text: String(text.prefix(Self.maxTextCharacters))))
        trim()
    }

    public mutating func reset() {
        turns.removeAll(keepingCapacity: true)
    }

    private mutating func trim() {
        if turns.count > Self.maxTurns {
            turns.removeFirst(turns.count - Self.maxTurns)
        }
        while totalCharacters > Self.maxCharacters, !turns.isEmpty {
            turns.removeFirst()
        }
    }

    private var totalCharacters: Int {
        turns.reduce(0) { $0 + $1.text.count }
    }
}
