import Foundation

public enum CharacterContextBuilder {
    public static func make(identity: CharacterIdentity?, memories: [CharacterMemory],
                            capabilities: [CharacterCapability] = [], query: String,
                            limit: Int = 2_000, memoryLimit: Int = 4) -> String? {
        guard limit > 0, memoryLimit > 0 else { return nil }
        var sections: [String] = []
        let identityHeader = "角色资料（用户确认）：\n"
        if let identity, !CharacterMemoryReview.isCredentialLike(identity.promptText),
           !identity.promptText.isEmpty, limit > identityHeader.count {
            // The shipped persona fits in full; custom profiles remain bounded.
            let budget = min(1_200, limit - identityHeader.count)
            sections.append(identityHeader + identity.promptText.prefix(budget))
        }

        let relevantMemories = CharacterMemoryRetriever.relevant(
            to: query, in: memories, limit: memoryLimit, onlineAuthorizedOnly: true,
            includeKnowledgeProvenance: true
        ) {
            CharacterMemoryReview.isCredentialLike([$0.text, $0.source, $0.citation, $0.version].joined(separator: " "))
                || CharacterMemoryReview.hasUnresolvedKnowledgeConflict($0, against: memories)
        }

        var used = sections.joined(separator: "\n\n").count
        var memoryLines: [String] = []
        var knowledgeLines: [String] = []
        for memory in relevantMemories {
            let line: String
            if memory.kind == .knowledge {
                let provenance = [
                    memory.source.isEmpty ? nil : "来源：\(memory.source)",
                    memory.citation.isEmpty ? nil : "引用：\(memory.citation)",
                    memory.version.isEmpty ? nil : "版本：\(memory.version)"
                ].compactMap { $0 }.joined(separator: "；")
                line = provenance.isEmpty ? "- \(memory.text)" : "- [\(provenance)] \(memory.text)"
            } else {
                line = "- [\(memory.kind.rawValue)] \(memory.text)"
            }
            guard used + line.count + 36 <= limit else { continue }
            if memory.kind == .knowledge {
                knowledgeLines.append(line)
            } else {
                memoryLines.append(line)
            }
            used += line.count + 1
        }
        if !memoryLines.isEmpty {
            sections.append("与本轮问题相关且已获准分享的用户记忆：\n" + memoryLines.joined(separator: "\n"))
        }
        if !knowledgeLines.isEmpty {
            sections.append("与本轮问题相关且已获准分享的角色知识：\n" + knowledgeLines.joined(separator: "\n"))
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
}
