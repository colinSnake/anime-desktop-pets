import Foundation

public enum CharacterContextBuilder {
    public static func make(identity: CharacterIdentity?, memories: [CharacterMemory],
                            capabilities: [CharacterCapability] = [], query: String,
                            limit: Int = 2_000, memoryLimit: Int = 4) -> String? {
        guard limit > 0, memoryLimit > 0 else { return nil }
        var sections: [String] = []
        if let identity, !identity.promptText.isEmpty {
            sections.append("角色资料（用户确认）：\n\(identity.promptText.prefix(min(600, limit)))")
        }

        let relevantMemories = CharacterMemoryRetriever.relevant(
            to: query, in: memories, limit: memoryLimit, onlineAuthorizedOnly: true
        ).filter { !CharacterMemoryReview.isCredentialLike($0.text) }

        var used = sections.joined(separator: "\n\n").count
        var memoryLines: [String] = []
        for memory in relevantMemories {
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
}
