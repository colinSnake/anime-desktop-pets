import Foundation

public enum CharacterMemoryRetriever {
    private static let ignoredTerms: Set<String> = [
        "我", "你", "他", "她", "它", "我们", "你们", "什么", "怎么", "为什么", "是不是",
        "可以", "能不能", "一下", "请问", "告诉", "觉得", "记得", "关于", "这个", "那个",
        "之前", "说过", "告诉过", "跟你", "喜欢什么", "记住了",
    ]

    public static func relevant(to query: String, in memories: [CharacterMemory], limit: Int = 4,
                                onlineAuthorizedOnly: Bool = false) -> [CharacterMemory] {
        guard limit > 0 else { return [] }
        let queryTerms = terms(in: retrievalQuery(query))
        return memories.compactMap { memory -> (CharacterMemory, Double)? in
            guard memory.status == .confirmed,
                  !onlineAuthorizedOnly || memory.shareWithOnlineModel else { return nil }
            let score = relevance(of: memory, queryTerms: queryTerms, query: query)
            return score > 0 ? (memory, score) : nil
        }
        .sorted { lhs, rhs in
            if lhs.1 != rhs.1 { return lhs.1 > rhs.1 }
            if lhs.0.createdAt != rhs.0.createdAt { return lhs.0.createdAt > rhs.0.createdAt }
            return lhs.0.id < rhs.0.id
        }
        .prefix(limit)
        .map(\.0)
    }

    public static func recent(in memories: [CharacterMemory], limit: Int = 3) -> [CharacterMemory] {
        guard limit > 0 else { return [] }
        return memories.filter { $0.status == .confirmed }
            .sorted { lhs, rhs in
                if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
                return lhs.id < rhs.id
            }
            .prefix(limit)
            .map { $0 }
    }

    private static func relevance(of memory: CharacterMemory, queryTerms: Set<String>, query: String) -> Double {
        let normalizedQuery = normalize(query)
        let normalizedContent = normalize(memory.text)
        if normalizedQuery.count >= 2, normalizedContent.contains(normalizedQuery) { return 2 }
        guard !queryTerms.isEmpty else { return 0 }
        let matches = queryTerms.intersection(terms(in: memory.text)).count
        guard matches > 0 else { return 0 }
        let coverage = Double(matches) / Double(queryTerms.count)
        return coverage >= 0.25 ? coverage : 0
    }

    private static func terms(in text: String) -> Set<String> {
        let scalars = Array(normalize(text).unicodeScalars)
        var result = Set<String>()
        var index = 0
        while index < scalars.count {
            if isCJK(scalars[index]) {
                if index + 1 < scalars.count, isCJK(scalars[index + 1]) {
                    result.insert(String(String.UnicodeScalarView([scalars[index], scalars[index + 1]])))
                }
                index += 1
            } else if CharacterSet.alphanumerics.contains(scalars[index]) {
                var end = index + 1
                while end < scalars.count, !isCJK(scalars[end]), CharacterSet.alphanumerics.contains(scalars[end]) {
                    end += 1
                }
                let token = String(String.UnicodeScalarView(scalars[index..<end]))
                if token.count > 1 { result.insert(token) }
                index = end
            } else {
                index += 1
            }
        }
        result.subtract(ignoredTerms)
        return result
    }

    private static func normalize(_ text: String) -> String {
        text.lowercased().filter { !$0.isWhitespace && !$0.isPunctuation && !$0.isSymbol }
    }

    private static func retrievalQuery(_ query: String) -> String {
        var value = normalize(query)
        for phrase in ["你还记得我", "你记得我", "你记住我", "我之前说过", "我告诉过你", "我跟你说过",
                       "你记得", "你记住了", "记得", "记住了", "喜欢什么"] {
            value = value.replacingOccurrences(of: normalize(phrase), with: " ")
        }
        return value
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        (0x3400...0x9FFF).contains(scalar.value) || (0xF900...0xFAFF).contains(scalar.value)
    }
}
