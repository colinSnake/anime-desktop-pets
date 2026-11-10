import Foundation

public enum CharacterKnowledgeImportError: LocalizedError {
    case invalidText, tooLarge, invalidMetadata, credential, expired
    public var errorDescription: String? {
        switch self {
        case .invalidText: "知识文件需为非空 UTF-8 文本，按空行分段，每段最多1,000字符。"
        case .tooLarge: "单次导入最多32KiB、50段知识，请拆分文件后重试。"
        case .invalidMetadata: "请填写知识来源，并缩短来源、引用或版本字段。"
        case .credential: "知识正文或来源包含疑似凭证信息，未导入。"
        case .expired: "知识有效期已到，请更新依据和有效期后重新审核。"
        }
    }
}

/// Plain text only; Markdown front matter is never treated as authorization.
public enum CharacterKnowledgeImport {
    public static let maxBytes = 32 * 1024
    public static let maxEntries = 50

    public static func preview(text: String, source: String, citation: String = "", version: String = "",
                               expiresAt: Date? = nil, now: Date = .now) throws -> [CharacterMemory] {
        guard text.utf8.count <= maxBytes else { throw CharacterKnowledgeImportError.tooLarge }
        let source = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty, source.count <= 200, citation.count <= 500, version.count <= 80,
              ![source, citation, version].contains(where: { $0.contains("\n") || $0.contains("\r") }) else {
            throw CharacterKnowledgeImportError.invalidMetadata
        }
        let expiresAt = expiresAt.map { Date(timeIntervalSince1970: floor($0.timeIntervalSince1970)) }
        if let expiresAt, expiresAt <= now { throw CharacterKnowledgeImportError.expired }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let paragraphs = normalized.components(separatedBy: "\n")
            .reduce(into: [String]()) { chunks, line in
                if line.trimmingCharacters(in: .whitespaces).isEmpty { chunks.append("") }
                else if chunks.isEmpty { chunks.append(line) }
                else if chunks[chunks.count - 1].isEmpty { chunks[chunks.count - 1] = line }
                else { chunks[chunks.count - 1] += "\n" + line }
            }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !paragraphs.isEmpty, paragraphs.allSatisfy({ $0.count <= 1_000 && !$0.contains("\0") }) else {
            throw CharacterKnowledgeImportError.invalidText
        }
        guard paragraphs.count <= maxEntries else { throw CharacterKnowledgeImportError.tooLarge }
        var unique = Set<String>()
        let entries = try paragraphs.filter { unique.insert($0).inserted }.enumerated().map { index, text in
            // One selected reference may span several facts. Give each imported paragraph
            // an explicit local location so different paragraphs do not become provenance conflicts.
            let location = citation.isEmpty ? "" : "\(citation)（导入文本第 \(index + 1) 段）"
            guard location.count <= 500 else { throw CharacterKnowledgeImportError.invalidMetadata }
            return CharacterMemory(kind: .knowledge, text: text, createdAt: now, source: source,
                                   citation: location, version: version, expiresAt: expiresAt)
        }
        guard !entries.contains(where: { CharacterMemoryReview.isCredentialLike(CharacterMemoryReview.memoryContent($0)) }) else {
            throw CharacterKnowledgeImportError.credential
        }
        return entries
    }
}
