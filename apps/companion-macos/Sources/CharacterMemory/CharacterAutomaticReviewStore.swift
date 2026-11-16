import CharacterCore
import Foundation

extension CharacterMemoryStore {
    /// One actor turn: a queued, cancelled review cannot write, and concurrent
    /// reviewers cannot both decide to insert the same confirmed evidence.
    public func applyAutomaticReview(_ suggestion: CharacterMemorySuggestion) throws -> CharacterMemoryReview.AutomationDecision {
        try Task.checkCancellation()
        let decision = suggestion.decision(against: try listMemories())
        try Task.checkCancellation()
        var memory = suggestion.memory
        memory.shareWithOnlineModel = false
        switch decision {
        case .autoConfirm:
            memory.status = .confirmed
            memory.confirmedAt = .now
            try saveMemory(memory)
        case .requiresReview(let reason):
            memory.status = .candidate
            memory.confirmedAt = nil
            memory.source = "AI 自动审核待核对：\(reason)"
            try saveMemory(memory)
        case .alreadyExists, .doNotStore:
            break
        }
        return decision
    }
}
