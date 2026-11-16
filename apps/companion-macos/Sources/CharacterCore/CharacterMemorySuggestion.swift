import Foundation

/// Untrusted model output. Only quoted user evidence can become a local record.
public struct CharacterMemorySuggestion: Sendable {
    public let memory: CharacterMemory
    public let confidence: Double
    public let isCompleteTurn: Bool

    private struct Response: Decodable { let suggestions: [Entry] }
    private struct Entry: Decodable {
        let kind: String
        let quote: String
        let confidence: Double
        let turnID: UUID
    }

    public enum ValidationError: Error { case invalidResponse }

    public static func eligibleTurns(_ turns: [CharacterChatTurn]) -> [CharacterChatTurn] {
        Array(turns.filter {
            $0.role == .user && !$0.text.isEmpty && $0.text.count <= CharacterChatSession.maxTextCharacters
                && !CharacterMemoryReview.isCredentialLike($0.text)
        }.suffix(6))
    }

    public static func parse(_ text: String, turns: [CharacterChatTurn]) throws -> [Self] {
        guard text.utf8.count <= 32_768 else { throw ValidationError.invalidResponse }
        let response = try JSONDecoder().decode(Response.self, from: Data(text.utf8))
        guard response.suggestions.count <= 6 else { throw ValidationError.invalidResponse }
        return try response.suggestions.map { entry in
            let kinds: [String: CharacterMemoryKind] = ["fact": .fact, "preference": .preference, "episode": .episode]
            guard let kind = kinds[entry.kind], entry.confidence.isFinite, (0...1).contains(entry.confidence),
                  !entry.quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, entry.quote.count <= 1_000,
                  let turn = turns.first(where: { $0.id == entry.turnID && $0.role == .user }),
                  turn.text.contains(entry.quote) else { throw ValidationError.invalidResponse }
            let memory = CharacterMemory(kind: kind, text: entry.quote,
                source: "AI 自动审核 · 用户原话", citation: "turn:\(entry.turnID.uuidString)")
            return Self(memory: memory, confidence: entry.confidence, isCompleteTurn: turn.text == entry.quote)
        }
    }

    public func decision(against memories: [CharacterMemory]) -> CharacterMemoryReview.AutomationDecision {
        let policy = CharacterMemoryReview.automationDecision(for: memory, against: memories)
        guard case .autoConfirm = policy else { return policy }
        guard confidence >= 0.90 else { return .requiresReview("AI 置信度不足，未自动确认") }
        // Substrings can omit negations or quotation context: retain human review.
        guard isCompleteTurn else { return .requiresReview("证据仅为发言片段，请核对上下文") }
        return .autoConfirm
    }
}
