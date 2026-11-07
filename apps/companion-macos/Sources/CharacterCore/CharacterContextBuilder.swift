import Foundation

public enum CharacterContextBuilder {
    private static let ignoredTerms: Set<String> = [
        "我", "你", "他", "她", "它", "我们", "你们", "什么", "怎么", "为什么", "是不是",
        "可以", "能不能", "一下", "请问", "告诉", "觉得", "记得", "关于", "这个", "那个",
    ]

    public static func make(identity: CharacterIdentity?, memories: [CharacterMemory],
                            capabilities: [CharacterCapability] = [], query: String,
                            limit: Int = 2_000, memoryLimit: Int = 4) -> String? {
        guard limit > 0, memoryLimit > 0 else { return nil }
        var sections: [String] = []
        if let identity, !identity.promptText.isEmpty {
            sections.append("角色资料（用户确认）：\n\(identity.promptText.prefix(min(600, limit)))")
        }

        let queryTerms = terms(in: query)
        let ranked = memories.compactMap { memory -> (CharacterMemory, Double)? in
            guard memory.status == .confirmed, memory.shareWithOnlineModel else { return nil }
            let score = relevance(of: memory, queryTerms: queryTerms, query: query)
            return score > 0 ? (memory, score) : nil
        }
        .sorted { lhs, rhs in
            if lhs.1 != rhs.1 { return lhs.1 > rhs.1 }
            return lhs.0.createdAt > rhs.0.createdAt
        }

        var used = sections.joined(separator: "\n\n").count
        var memoryLines: [String] = []
        for (memory, _) in ranked.prefix(memoryLimit) {
            let line = "- [\(memory.kind.rawValue)] \(memory.text)"
            guard used + line.count + 36 <= limit else { continue }
            memoryLines.append(line)
            used += line.count + 1
        }
        if !memoryLines.isEmpty {
            sections.append("与本轮问题相关且已获准分享的记忆：\n" + memoryLines.joined(separator: "\n"))
        }

        if !capabilities.isEmpty {
            let remaining = max(0, limit - sections.joined(separator: "\n\n").count - 30)
            let lines = capabilities.map { "- \($0.name)：\($0.status.rawValue)，\($0.detail)" }
            var capabilityLines: [String] = []
            var capabilityCharacters = 0
            for line in lines where capabilityCharacters + line.count + 1 <= remaining {
                capabilityLines.append(line)
                capabilityCharacters += line.count + 1
            }
            if !capabilityLines.isEmpty {
                sections.append("应用实时能力状态：\n" + capabilityLines.joined(separator: "\n"))
            }
        }
        let result = sections.joined(separator: "\n\n")
        return result.isEmpty ? nil : result
    }

    private static func relevance(of memory: CharacterMemory, queryTerms: Set<String>, query: String) -> Double {
        let query = normalized(query)
        let content = normalized(memory.text)
        if query.count >= 2, content.contains(query) { return 2 }
        guard !queryTerms.isEmpty else { return 0 }
        let contentTerms = terms(in: memory.text)
        let matches = queryTerms.intersection(contentTerms).count
        guard matches > 0 else { return 0 }
        let coverage = Double(matches) / Double(queryTerms.count)
        return coverage >= 0.25 ? coverage : 0
    }

    private static func terms(in text: String) -> Set<String> {
        let normalized = normalized(text)
        let scalars = Array(normalized.unicodeScalars)
        var result = Set<String>()
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if isCJK(scalar) {
                if index + 1 < scalars.count, isCJK(scalars[index + 1]) {
                    result.insert(String(String.UnicodeScalarView([scalar, scalars[index + 1]])))
                }
                index += 1
                continue
            }
            if CharacterSet.alphanumerics.contains(scalar) {
                var end = index + 1
                while end < scalars.count, !isCJK(scalars[end]), CharacterSet.alphanumerics.contains(scalars[end]) {
                    end += 1
                }
                let token = String(String.UnicodeScalarView(scalars[index..<end]))
                if token.count > 1 { result.insert(token) }
                index = end
                continue
            }
            index += 1
        }
        result.subtract(ignoredTerms)
        return result
    }

    private static func normalized(_ text: String) -> String {
        text.lowercased().filter { !$0.isWhitespace && !$0.isPunctuation && !$0.isSymbol }
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        (0x3400...0x9FFF).contains(scalar.value) || (0xF900...0xFAFF).contains(scalar.value)
    }
}
