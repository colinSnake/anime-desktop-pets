import Foundation

public enum CharacterMemoryKind: String, Codable, CaseIterable, Sendable {
    case fact = "事实"
    case preference = "偏好"
    case episode = "经历"
    case knowledge = "知识"
}

public struct CharacterMemory: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable {
        case candidate
        case confirmed
    }

    public var id: String
    public var kind: CharacterMemoryKind
    public var text: String
    public var createdAt: Date
    public var source: String
    public var status: Status
    public var shareWithOnlineModel: Bool

    public init(id: String = UUID().uuidString.lowercased(), kind: CharacterMemoryKind,
                text: String, createdAt: Date = .now, source: String,
                status: Status = .candidate, shareWithOnlineModel: Bool = false) {
        self.id = id
        self.kind = kind
        self.text = text
        self.createdAt = createdAt
        self.source = source
        self.status = status
        self.shareWithOnlineModel = shareWithOnlineModel
    }
}

public enum CharacterContextBuilder {
    public static func make(identity: CharacterIdentity?, memories: [CharacterMemory],
                            capabilities: [CharacterCapability] = [], limit: Int = 2_000) -> String? {
        guard limit > 0 else { return nil }
        var sections: [String] = []
        if let identity, !identity.promptText.isEmpty {
            sections.append("角色资料（用户确认）：\n\(identity.promptText.prefix(min(600, limit)))")
        }
        let allowed = memories.filter { $0.status == .confirmed && $0.shareWithOnlineModel }
            .sorted { $0.createdAt > $1.createdAt }
        if !allowed.isEmpty, limit > 120 {
            var memoryLines: [String] = []
            var used = sections.joined(separator: "\n\n").count
            for item in allowed {
                let line = "- [\(item.kind.rawValue)] \(item.text)"
                guard used + line.count + 36 <= limit else { continue }
                memoryLines.append(line)
                used += line.count + 1
            }
            if !memoryLines.isEmpty {
                sections.append("用户允许本轮使用的记忆：\n" + memoryLines.joined(separator: "\n"))
            }
        }
        if !capabilities.isEmpty {
            let remaining = max(0, limit - sections.joined(separator: "\n\n").count - 30)
            let lines = capabilities.map { "- \($0.name)：\($0.status.rawValue)，\($0.detail)" }
            var capabilityLines: [String] = []
            var used = 0
            for line in lines where used + line.count + 1 <= remaining {
                capabilityLines.append(line)
                used += line.count + 1
            }
            if !capabilityLines.isEmpty {
                sections.append("应用实时能力状态：\n" + capabilityLines.joined(separator: "\n"))
            }
        }
        let result = sections.joined(separator: "\n\n")
        guard !result.isEmpty else { return nil }
        return result
    }
}

public enum CharacterCommand {
    public static func rememberText(in input: String) -> String? {
        let normalized = input.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["请记住", "记住"] where normalized.hasPrefix(prefix) {
            let remainder = normalized.dropFirst(prefix.count)
                .trimmingCharacters(in: CharacterSet(charactersIn: "：:,，；; \n\t"))
            let text = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
            let questionOnly = ["了吗", "什么", "沒有嗎", "没有吗", "什麼"].contains(where: text.hasPrefix)
            guard !text.isEmpty, !questionOnly, text.count <= 1_000 else { return nil }
            return text
        }
        return nil
    }
}

public enum CharacterLocalAnswer {
    public static func answer(for input: String, identity: CharacterIdentity, memories: [CharacterMemory],
                              capabilities: [CharacterCapability]) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.contains("你是谁") || text.contains("介绍一下自己") || text.contains("自我介绍") {
            let background = identity.background.trimmingCharacters(in: .whitespacesAndNewlines)
            let personality = identity.personality.trimmingCharacters(in: .whitespacesAndNewlines)
            var answer = "我是\(identity.name)。"
            if !background.isEmpty { answer += "\(background.prefix(36))。" }
            if !personality.isEmpty { answer += "我的性格是\(personality.prefix(24))。" }
            return String(answer.prefix(100))
        }
        if text.contains("你会什么") || text.contains("有什么能力") || text.contains("能做什么") {
            let available = capabilities.filter { $0.status == .enabled }.map(\.name)
            let unavailable = capabilities.filter { $0.status != .enabled }.map { "\($0.name)（\($0.status.rawValue)）" }
            let enabledText = available.isEmpty ? "暂时没有已启用能力" : "目前能\(available.joined(separator: "、"))"
            let unavailableText = unavailable.isEmpty ? "" : "；\(unavailable.joined(separator: "、"))尚未可用"
            return String((enabledText + unavailableText + "。具体状态以角色与记忆里的能力页为准。").prefix(100))
        }
        if text.contains("你记得什么") || text.contains("你记住了什么") ||
            text.contains("你还记得我什么") || text.contains("我的偏好") || text.contains("我记得什么") {
            let confirmed = memories.filter { $0.status == .confirmed }.sorted { $0.createdAt > $1.createdAt }
            guard !confirmed.isEmpty else { return "我这里还没有已确认的本地记忆。" }
            let items = confirmed.prefix(3).map { "\($0.kind.rawValue)：\($0.text)" }
            return String(("我记得：" + items.joined(separator: "；")).prefix(100))
        }
        return nil
    }
}
