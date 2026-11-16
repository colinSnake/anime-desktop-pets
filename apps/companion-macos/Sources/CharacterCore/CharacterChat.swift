import Foundation

public enum CharacterChatRole: String, Codable, Sendable {
    case user
    case assistant
}

public struct CharacterChatTurn: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let role: CharacterChatRole
    public let text: String
    /// Recorded when the turn is appended, not when its view renders. Nil for legacy turns.
    public let createdAt: Date?

    public init(role: CharacterChatRole, text: String, createdAt: Date? = Date(), id: UUID = UUID()) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case id, role, text, createdAt }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        role = try values.decode(CharacterChatRole.self, forKey: .role)
        text = try values.decode(String.self, forKey: .text)
        createdAt = try values.decodeIfPresent(Date.self, forKey: .createdAt)
    }
}

/// An in-memory transcript for one chat window. It retains complete replies and
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
        turns.append(CharacterChatTurn(role: turn.role, text: turn.role == .user ? String(text.prefix(Self.maxTextCharacters)) : text,
                                       createdAt: turn.createdAt, id: turn.id))
        trim()
    }

    /// API context is intentionally smaller than the visible transcript.
    public static func requestHistory(from turns: [CharacterChatTurn]) -> [CharacterChatTurn] {
        let bounded = turns.map { turn in
            CharacterChatTurn(role: turn.role, text: String(turn.text.prefix(maxTextCharacters)),
                              createdAt: turn.createdAt, id: turn.id)
        }
        return Self(turns: bounded).turns
    }

    public mutating func reset() {
        turns.removeAll(keepingCapacity: true)
    }

    private mutating func trim() {
        if turns.count > Self.maxTurns {
            turns.removeFirst(turns.count - Self.maxTurns)
        }
        // Keep the newest exchange intact even when one complete answer exceeds
        // the history budget. Network context is bounded independently below.
        while totalCharacters > Self.maxCharacters, turns.count > 2 {
            turns.removeFirst()
        }
    }

    private var totalCharacters: Int {
        turns.reduce(0) { $0 + $1.text.count }
    }
}
