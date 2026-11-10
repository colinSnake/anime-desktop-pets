import Foundation

public enum CharacterMemoryReview {
    public enum Finding: Equatable, Sendable {
        case expired
        case possibleDuplicate(CharacterMemory)
        case possibleConflict(CharacterMemory)
        case possibleKnowledgeConflict(CharacterMemory)

        public var title: String {
            switch self {
            case .expired: "知识已过期"
            case .possibleDuplicate: "可能重复"
            case .possibleConflict: "可能冲突"
            case .possibleKnowledgeConflict: "知识依据冲突"
            }
        }

        public var message: String {
            switch self {
            case .expired: "请核对最新依据、更新有效期并重新确认；过期知识不参与回答。"
            case .possibleDuplicate(let memory): "与已有记忆相同：\(memory.text)"
            case .possibleConflict(let memory): "与已有记忆可能相反：\(memory.text)"
            case .possibleKnowledgeConflict(let memory): "同一来源、引用和版本下已有不同内容：\(memory.text)"
            }
        }
    }

    public enum AutomationDecision: Equatable, Sendable {
        case autoConfirm
        case alreadyExists(CharacterMemory)
        case requiresReview(String)
        case doNotStore
    }

    public static func automationDecision(for candidate: CharacterMemory,
                                         against memories: [CharacterMemory]) -> AutomationDecision {
        let value = candidate.text.lowercased()
        if isCredentialLike(memoryContent(candidate)) { return .doNotStore }
        if candidate.isExpired() { return .requiresReview("知识已过期") }

        let reviewTerms = ["银行卡", "身份证", "账号", "支付", "转账", "病史", "诊断", "用药", "医疗"]
        if let term = reviewTerms.first(where: value.contains) {
            return .requiresReview("内容可能包含敏感信息（\(term)）")
        }

        // A credential must never be retained, even when an older memory happens to
        // look identical. Sensitive details and conflicts stay visible to the user.
        let findings = findings(for: candidate, against: memories)
        if let conflict = findings.first(where: {
            if case .possibleConflict = $0 { return true }
            return false
        }), case .possibleConflict(let existing) = conflict {
            return .requiresReview("发现可能冲突：与已有记忆可能相反：\(existing.text)")
        }
        if let duplicate = findings.first(where: {
            if case .possibleDuplicate = $0 { return true }
            return false
        }), case .possibleDuplicate(let existing) = duplicate {
            return .alreadyExists(existing)
        }
        if let knowledgeConflict = findings.first(where: {
            if case .possibleKnowledgeConflict = $0 { return true }
            return false
        }), case .possibleKnowledgeConflict(let existing) = knowledgeConflict {
            return .requiresReview("发现知识依据冲突：与已有条目内容不同：\(existing.text)")
        }
        if let finding = findings.first {
            return .requiresReview("发现\(finding.title)：\(finding.message)")
        }
        return .autoConfirm
    }

    /// Credential-like text is never sent to an online model, even if a legacy
    /// or manually edited memory file says it is shareable.
    public static func isCredentialLike(_ text: String) -> Bool {
        let value = text.lowercased()
        let terms = ["密码", "密钥", "api key", "apikey", "验证码", "私钥", "助记词", "token", "cookie"]
        return terms.contains(where: value.contains)
    }

    public static func memoryContent(_ memory: CharacterMemory) -> String {
        [memory.text, memory.source, memory.citation, memory.version].joined(separator: " ")
    }

    public static func findings(for candidate: CharacterMemory,
                               against memories: [CharacterMemory], now: Date = .now) -> [Finding] {
        let candidateText = normalize(candidate.text)
        guard !candidateText.isEmpty else { return [] }
        let expiry: [Finding] = candidate.isExpired(at: now) ? [.expired] : []
        return expiry + memories
            .filter { $0.id != candidate.id && !$0.isExpired(at: now) && $0.status == .confirmed && $0.kind == candidate.kind }
            .compactMap { existing in
                if normalize(existing.text) == candidateText {
                    return .possibleDuplicate(existing)
                }
                if candidate.kind == .knowledge, sameKnowledgeProvenance(candidate, existing) {
                    return .possibleKnowledgeConflict(existing)
                }
                guard candidate.kind == .fact || candidate.kind == .preference,
                      hasOppositePolarity(candidate.text, existing.text),
                      sharedTopic(candidate.text, existing.text) else { return nil }
                return .possibleConflict(existing)
            }
    }

    public static func hasUnresolvedKnowledgeConflict(_ memory: CharacterMemory,
                                                       against memories: [CharacterMemory], now: Date = .now) -> Bool {
        findings(for: memory, against: memories, now: now).contains {
            if case .possibleKnowledgeConflict = $0 { return true }
            return false
        }
    }

    private static func sameKnowledgeProvenance(_ lhs: CharacterMemory, _ rhs: CharacterMemory) -> Bool {
        guard lhs.kind == .knowledge, rhs.kind == .knowledge,
              !lhs.source.isEmpty, !lhs.citation.isEmpty else { return false }
        return normalize(lhs.source) == normalize(rhs.source)
            && normalize(lhs.citation) == normalize(rhs.citation)
            && normalize(lhs.version) == normalize(rhs.version)
    }

    private static func hasOppositePolarity(_ lhs: String, _ rhs: String) -> Bool {
        isNegative(lhs) != isNegative(rhs)
    }

    private static func isNegative(_ text: String) -> Bool {
        let value = normalize(text)
        return ["不喜欢", "讨厌", "不要", "不能", "不是", "不想", "已经不", "没有"].contains { value.contains($0) }
    }

    private static func sharedTopic(_ lhs: String, _ rhs: String) -> Bool {
        let left = terms(in: lhs)
        let right = terms(in: rhs)
        return left.intersection(right).count >= 2
    }

    private static func terms(in text: String) -> Set<String> {
        let scalars = Array(normalize(text).unicodeScalars)
        var result = Set<String>()
        var index = 0
        while index + 1 < scalars.count {
            if isCJK(scalars[index]), isCJK(scalars[index + 1]) {
                let term = String(String.UnicodeScalarView([scalars[index], scalars[index + 1]]))
                if !["喜欢", "不喜", "讨厌", "不要", "不能", "不是", "不想", "已经", "没有"].contains(term) {
                    result.insert(term)
                }
            }
            index += 1
        }
        return result
    }

    private static func normalize(_ text: String) -> String {
        text.lowercased().filter { !$0.isWhitespace && !$0.isPunctuation && !$0.isSymbol }
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        (0x3400...0x9FFF).contains(scalar.value) || (0xF900...0xFAFF).contains(scalar.value)
    }
}
