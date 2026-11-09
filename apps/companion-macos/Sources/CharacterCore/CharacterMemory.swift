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
    /// Optional provenance details used by character knowledge entries.
    public var citation: String
    public var version: String
    public var status: Status
    public var shareWithOnlineModel: Bool

    public init(id: String = UUID().uuidString.lowercased(), kind: CharacterMemoryKind,
                text: String, createdAt: Date = .now, source: String,
                citation: String = "", version: String = "",
                status: Status = .candidate, shareWithOnlineModel: Bool = false) {
        self.id = id
        self.kind = kind
        self.text = text
        self.createdAt = createdAt
        self.source = source
        self.citation = citation
        self.version = version
        self.status = status
        self.shareWithOnlineModel = shareWithOnlineModel
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
            let role = identity.role.trimmingCharacters(in: .whitespacesAndNewlines)
            var answer = "我是\(identity.name)。"
            if !role.isEmpty { answer += "我是\(role.prefix(24))。" }
            if !background.isEmpty { answer += "\(background.prefix(36))。" }
            if !personality.isEmpty { answer += "我的性格是\(personality.prefix(24))。" }
            return String(answer.prefix(100))
        }
        if isKnowledgeRecallQuestion(text) {
            let knowledge = locallyAnswerable(memories.filter { $0.kind == .knowledge }, against: memories)
            let matches = isBroadKnowledgeRecall(text)
                ? CharacterMemoryRetriever.recent(in: knowledge)
                : CharacterMemoryRetriever.relevant(to: text, in: knowledge, limit: 3,
                                                    includeKnowledgeProvenance: true)
            guard !matches.isEmpty else { return "我还没有确认的角色知识。" }
            let items = matches.map { "知识：\($0.text)" }
            return String(("我目前确认的角色知识有：" + items.joined(separator: "；")).prefix(120))
        }
        if text.contains("你会什么") || text.contains("有什么能力") || text.contains("能做什么") {
            let available = capabilities.filter { $0.status == .enabled }.map(\.name)
            let unavailable = capabilities.filter { $0.status != .enabled }.map { "\($0.name)（\($0.status.rawValue)）" }
            let enabledText = available.isEmpty ? "暂时没有已启用能力" : "目前能\(available.joined(separator: "、"))"
            let unavailableText = unavailable.isEmpty ? "" : "；\(unavailable.joined(separator: "、"))尚未可用"
            return String((enabledText + unavailableText + "。具体状态以角色与记忆里的能力页为准。").prefix(100))
        }
        if isMemoryRecallQuestion(text) {
            let matches: [CharacterMemory]
            let answerable = locallyAnswerable(memories, against: memories)
            if text.contains("我的偏好") {
                matches = CharacterMemoryRetriever.recent(in: answerable.filter { $0.kind == .preference })
            } else if isBroadRecall(text) {
                matches = CharacterMemoryRetriever.recent(in: answerable)
            } else {
                matches = CharacterMemoryRetriever.relevant(to: text, in: answerable, limit: 3,
                                                            includeKnowledgeProvenance: true)
            }
            guard !matches.isEmpty else { return "我没有找到与这个问题相关的已确认记忆。" }
            let items = matches.map { "\($0.kind.rawValue)：\($0.text)" }
            return String(("我记得：" + items.joined(separator: "；")).prefix(100))
        }
        return nil
    }

    private static func locallyAnswerable(_ memories: [CharacterMemory],
                                          against allMemories: [CharacterMemory]) -> [CharacterMemory] {
        memories.filter { memory in
            let metadata = [memory.text, memory.source, memory.citation, memory.version].joined(separator: " ")
            guard !CharacterMemoryReview.isCredentialLike(metadata) else { return false }
            guard memory.kind == .knowledge else { return true }
            return !CharacterMemoryReview.hasUnresolvedKnowledgeConflict(memory, against: allMemories)
        }
    }

    private static func isKnowledgeRecallQuestion(_ text: String) -> Bool {
        ["角色知识", "来源", "引用", "版本", "你知道哪些角色知识", "你知道什么角色知识", "你的角色知识",
         "你了解这个角色什么", "你对自己知道什么"].contains(where: text.contains)
    }

    private static func isBroadKnowledgeRecall(_ text: String) -> Bool {
        ["你知道哪些角色知识", "你知道什么角色知识", "你的角色知识"].contains(where: text.contains)
    }

    private static func isMemoryRecallQuestion(_ text: String) -> Bool {
        ["你记得什么", "你记住了什么", "你还记得我什么", "我记得什么", "你记得我", "你记住我",
         "我的偏好", "我之前说过", "我告诉过你", "我跟你说过"]
            .contains(where: text.contains)
    }

    private static func isBroadRecall(_ text: String) -> Bool {
        ["你记得什么", "你记住了什么", "你还记得我什么", "我记得什么"]
            .contains(where: text.contains)
    }
}
