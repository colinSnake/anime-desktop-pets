import Foundation

/// A three-position expression overlay, never a replacement for CharacterIdentity.
public struct CharacterAdaptationDimensions: Codable, Equatable, Sendable {
    public let verbosity: Int
    public let playfulness: Int
    public let initiative: Int

    fileprivate static let neutral = Self(verbosity: 0, playfulness: 0, initiative: 0)
    fileprivate var isValid: Bool { [verbosity, playfulness, initiative].allSatisfy { (-1...1).contains($0) } }
}

public struct CharacterAdaptationEvidence: Codable, Equatable, Sendable {
    public let turnID: UUID
    /// Complete, verbatim explicit feedback; never included in promptText.
    public let text: String
    public let createdAt: Date
}

public struct CharacterAdaptationRevision: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case feedback, rollback, reset }
    public var id: Int { revision }
    public let revision: Int
    public let kind: Kind
    public let createdAt: Date
    public let reason: String
    public let evidence: CharacterAdaptationEvidence?
    public let before: CharacterAdaptationDimensions
    public let after: CharacterAdaptationDimensions
    public let revertedRevision: Int?
}

/// Local, reversible style settings. Observation never performs I/O or changes stable identity.
/// Repeating a preference (even via another input pipeline) sets the same level, not a larger nudge.
public struct CharacterAdaptationState: Codable, Equatable, Sendable {
    public static let maxHistoryCount = 30
    public var enabled = true
    public var shareWithOnlineModel = false
    public private(set) var revision = 0
    public private(set) var dimensions: CharacterAdaptationDimensions = .neutral
    public private(set) var history: [CharacterAdaptationRevision] = []
    private let schemaVersion: Int
    // Process-only authorization is deliberately excluded from Codable and value equality.
    private var sessionAuthorization: (@Sendable () -> (learning: Bool, sharing: Bool))?

    /// Store snapshots remain revocable even after they have been loaded by another window.
    public func withSessionAuthorization(
        _ authorization: @escaping @Sendable () -> (learning: Bool, sharing: Bool)
    ) -> Self {
        var copy = self
        copy.sessionAuthorization = authorization
        return copy
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.schemaVersion == rhs.schemaVersion && lhs.enabled == rhs.enabled
            && lhs.shareWithOnlineModel == rhs.shareWithOnlineModel && lhs.revision == rhs.revision
            && lhs.dimensions == rhs.dimensions && lhs.history == rhs.history
    }

    public init() { schemaVersion = 1 }
    public var verbosity: Int { dimensions.verbosity }
    public var playfulness: Int { dimensions.playfulness }
    public var initiative: Int { dimensions.initiative }

    public var summary: String {
        let detail = verbosity < 0 ? "简短" : verbosity > 0 ? "详细" : "默认"
        let tone = playfulness < 0 ? "稳重" : playfulness > 0 ? "活泼" : "默认"
        let suggestions = initiative < 0 ? "减少建议" : initiative > 0 ? "适度主动建议" : "默认"
        return "表达详略：\(detail)；活泼程度：\(tone)；建议主动性：\(suggestions)。"
            + (enabled ? "本地适应已开启；" : "本地适应已关闭；")
            + (shareWithOnlineModel ? "已允许分享。" : "未分享给在线模型。")
    }

    /// Only fixed, bounded style phrases can leave the local adaptation layer, never evidence/reasons.
    public var promptText: String {
        let authorization = sessionAuthorization?()
        guard enabled, shareWithOnlineModel, dimensions != .neutral,
              authorization?.learning != false, authorization?.sharing != false else { return "" }
        var lines = ["已授权的有限表达偏好：只调整表达，不改变稳定身份、姓名、背景、价值观或安全边界。"]
        if verbosity < 0 { lines.append("回复更简短，通常不超过3句、120字；保留必要的准确性与安全信息，不为凑短而省略关键内容。") }
        if verbosity > 0 { lines.append("回复适度详细，解释必要信息。") }
        if playfulness < 0 { lines.append("语气更稳重。") }
        if playfulness > 0 { lines.append("语气适度活泼。") }
        if initiative < 0 { lines.append("减少主动提出建议。") }
        if initiative > 0 { lines.append("适度主动提出建议，但不执行任何行动或扩大权限。") }
        return lines.joined(separator: "\n")
    }

    @discardableResult
    public mutating func observe(_ turn: CharacterChatTurn) -> Bool {
        guard enabled, sessionAuthorization?().learning != false, revision < Int.max, turn.role == .user,
              !history.contains(where: { $0.evidence?.turnID == turn.id }),
              let feedback = Feedback.match(turn.text) else { return false }
        let time = turn.createdAt ?? Date()
        guard Self.validTime(time) else { return false }
        let next = feedback.applying(to: dimensions)
        guard next != dimensions else { return false }
        append(kind: .feedback, after: next, reason: feedback.reason,
               evidence: .init(turnID: turn.id, text: turn.text, createdAt: time))
        return true
    }

    /// Undo the latest still-active feedback retained in the bounded history. Never toggles consent.
    @discardableResult
    public mutating func rollback() -> Bool {
        guard revision < Int.max, let target = Self.rollbackTarget(in: history) else { return false }
        append(kind: .rollback, after: target.before, reason: Self.rollbackReason, revertedRevision: target.revision)
        return true
    }

    /// Restore neutral expression and prevent rollback across this reset; consent is preserved.
    public mutating func reset() {
        guard revision < Int.max else { return }
        append(kind: .reset, after: .neutral, reason: Self.resetReason)
    }

    private mutating func append(kind: CharacterAdaptationRevision.Kind, after: CharacterAdaptationDimensions,
                                 reason: String, evidence: CharacterAdaptationEvidence? = nil, revertedRevision: Int? = nil) {
        revision += 1
        history.append(.init(revision: revision, kind: kind, createdAt: Date(), reason: reason,
                             evidence: evidence, before: dimensions, after: after, revertedRevision: revertedRevision))
        dimensions = after
        if history.count > Self.maxHistoryCount { history.removeFirst(history.count - Self.maxHistoryCount) }
    }

    private static let rollbackReason = "用户回滚最近一次表达调整。"
    private static let resetReason = "用户重置有限表达偏好。"

    private static func rollbackTarget(in entries: [CharacterAdaptationRevision]) -> CharacterAdaptationRevision? {
        var undone = Set<Int>()
        for entry in entries.reversed() {
            switch entry.kind {
            case .reset: return nil
            case .rollback:
                if let revision = entry.revertedRevision { undone.insert(revision) }
            case .feedback:
                if !undone.contains(entry.revision) { return entry }
            }
        }
        return nil
    }

    private static func validTime(_ time: Date) -> Bool {
        time.timeIntervalSince1970.isFinite && abs(time.timeIntervalSince1970) < 1_000_000_000_000
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, enabled, shareWithOnlineModel, revision, dimensions, history
    }

    /// Malformed imports fail closed, rather than silently enabling learning or sharing.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        enabled = try values.decode(Bool.self, forKey: .enabled)
        shareWithOnlineModel = try values.decode(Bool.self, forKey: .shareWithOnlineModel)
        revision = try values.decode(Int.self, forKey: .revision)
        dimensions = try values.decode(CharacterAdaptationDimensions.self, forKey: .dimensions)
        var entries = try values.nestedUnkeyedContainer(forKey: .history)
        history = []
        while !entries.isAtEnd {
            guard history.count < Self.maxHistoryCount else {
                throw DecodingError.dataCorruptedError(in: entries, debugDescription: "Adaptation history exceeds limit")
            }
            history.append(try entries.decode(CharacterAdaptationRevision.self))
        }
        guard isValid else {
            throw DecodingError.dataCorruptedError(forKey: .history, in: values, debugDescription: "Invalid adaptation state")
        }
    }

    private var isValid: Bool {
        guard schemaVersion == 1, revision >= 0, dimensions.isValid,
              history.count == min(revision, Self.maxHistoryCount) else { return false }
        guard !history.isEmpty else { return revision == 0 && dimensions == .neutral }
        guard history.last?.revision == revision, history.last?.after == dimensions else { return false }
        var seenTurns = Set<UUID>()
        var undone = Set<Int>()
        for (index, entry) in history.enumerated() {
            guard entry.revision > 0, entry.before.isValid, entry.after.isValid, Self.validTime(entry.createdAt) else { return false }
            if index > 0 {
                let previous = history[index - 1]
                guard previous.revision < Int.max, entry.revision == previous.revision + 1,
                      entry.before == previous.after else { return false }
            } else if entry.revision == 1, entry.before != .neutral { return false }
            switch entry.kind {
            case .feedback:
                guard let evidence = entry.evidence, Self.validTime(evidence.createdAt),
                      seenTurns.insert(evidence.turnID).inserted, let feedback = Feedback.match(evidence.text),
                      entry.revertedRevision == nil, entry.reason == feedback.reason,
                      entry.after != entry.before, feedback.applying(to: entry.before) == entry.after else { return false }
            case .rollback:
                guard entry.evidence == nil, entry.reason == Self.rollbackReason,
                      let target = entry.revertedRevision, target > 0, target < entry.revision,
                      undone.insert(target).inserted, entry.after != entry.before else { return false }
                let prefix = Array(history.prefix(index))
                if let known = Self.rollbackTarget(in: prefix) {
                    guard target == known.revision, entry.before == known.after, entry.after == known.before else { return false }
                } else {
                    // The undo target may have fallen off the front of the 30-entry audit tail.
                    guard target < history[0].revision, !prefix.contains(where: { $0.kind == .reset }),
                          zip([entry.before.verbosity, entry.before.playfulness, entry.before.initiative],
                              [entry.after.verbosity, entry.after.playfulness, entry.after.initiative])
                            .filter({ $0 != $1 }).count == 1 else { return false }
                }
            case .reset:
                guard entry.evidence == nil, entry.revertedRevision == nil,
                      entry.reason == Self.resetReason, entry.after == .neutral else { return false }
            }
        }
        return true
    }

    /// Whole-utterance allowlist, intentionally not a natural-language/substr matching classifier.
    /// Quotation, negation, third-party text, credentials, questions and extra instructions cannot match.
    private enum Feedback: CaseIterable {
        case concise, detailed, playful, serious, moreSuggestions, fewerSuggestions

        var phrases: [String] {
            switch self {
            case .concise:
                ["请简短一点", "请简洁一点", "请更简短一点", "请回复简短一点", "请回答简短一点", "请说短一点",
                 "以后回复简短一点", "以后回复请简短一点", "以后请回答简短一点", "以后回答简短一点", "回复简短一点", "回答简短一点",
                 "please keep your replies shorter", "please be more concise", "please keep replies short"]
            case .detailed:
                ["请详细一点", "请回复详细一点", "请回答详细一点", "请多解释一点", "以后回复详细一点",
                 "please give more detailed replies", "please explain in more detail"]
            case .playful:
                ["请活泼一点", "请更活泼一点", "以后请活泼一点", "please be more playful"]
            case .serious:
                ["请稳重一点", "请严肃一点", "please use a more serious tone"]
            case .moreSuggestions:
                ["请多给一点建议", "请多给一些建议", "请主动给一点建议", "以后请多给一点建议", "please offer more suggestions"]
            case .fewerSuggestions:
                ["请少给一点建议", "请少给一些建议", "请减少主动建议", "请降低建议主动性", "please offer fewer suggestions"]
            }
        }

        var reason: String {
            switch self {
            case .concise: "用户明确要求更简短的回复。"
            case .detailed: "用户明确要求更详细的回复。"
            case .playful: "用户明确要求更活泼的语气。"
            case .serious: "用户明确要求更稳重的语气。"
            case .moreSuggestions: "用户明确要求适度增加主动建议。"
            case .fewerSuggestions: "用户明确要求减少主动建议。"
            }
        }

        func applying(to before: CharacterAdaptationDimensions) -> CharacterAdaptationDimensions {
            switch self {
            case .concise: .init(verbosity: -1, playfulness: before.playfulness, initiative: before.initiative)
            case .detailed: .init(verbosity: 1, playfulness: before.playfulness, initiative: before.initiative)
            case .playful: .init(verbosity: before.verbosity, playfulness: 1, initiative: before.initiative)
            case .serious: .init(verbosity: before.verbosity, playfulness: -1, initiative: before.initiative)
            case .moreSuggestions: .init(verbosity: before.verbosity, playfulness: before.playfulness, initiative: 1)
            case .fewerSuggestions: .init(verbosity: before.verbosity, playfulness: before.playfulness, initiative: -1)
            }
        }

        static func match(_ raw: String) -> Self? {
            guard raw.utf8.count <= 256, !CharacterMemoryReview.isCredentialLike(raw) else { return nil }
            var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let last = text.last, ["。", ".", "!", "！"].contains(last) { text.removeLast() }
            return allCases.first { $0.phrases.contains(text) }
        }
    }
}
