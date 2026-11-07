import Foundation

public struct CharacterIdentity: Codable, Equatable, Sendable {
    public var name: String
    public var role: String
    public var background: String
    public var personality: String
    public var values: String
    public var motivations: String
    public var relationship: String
    public var speakingStyle: String
    public var knowledgeScope: String
    public var boundaries: String
    public var shareWithOnlineModel: Bool

    public init(name: String, role: String = "", background: String = "", personality: String = "",
                values: String = "", motivations: String = "", relationship: String = "",
                speakingStyle: String = "", knowledgeScope: String = "", boundaries: String = "",
                shareWithOnlineModel: Bool = false) {
        self.name = name
        self.role = role
        self.background = background
        self.personality = personality
        self.values = values
        self.motivations = motivations
        self.relationship = relationship
        self.speakingStyle = speakingStyle
        self.knowledgeScope = knowledgeScope
        self.boundaries = boundaries
        self.shareWithOnlineModel = shareWithOnlineModel
    }

    public static func starter(name: String) -> CharacterIdentity {
        CharacterIdentity(name: name)
    }

    public var promptText: String {
        guard shareWithOnlineModel else { return "" }
        return [
            "名字：\(name)",
            nonempty("身份定位：", role),
            nonempty("背景：", background),
            nonempty("性格：", personality),
            nonempty("核心价值观：", values),
            nonempty("当前愿望与长期方向：", motivations),
            nonempty("与用户的关系：", relationship),
            nonempty("表达方式：", speakingStyle),
            nonempty("知识与擅长边界：", knowledgeScope),
            nonempty("边界：", boundaries),
        ].compactMap { $0 }.joined(separator: "\n")
    }

    private enum CodingKeys: String, CodingKey {
        case name, role, background, personality, values, motivations, relationship
        case speakingStyle, knowledgeScope, boundaries, shareWithOnlineModel
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        role = try values.decodeIfPresent(String.self, forKey: .role) ?? ""
        background = try values.decodeIfPresent(String.self, forKey: .background) ?? ""
        personality = try values.decodeIfPresent(String.self, forKey: .personality) ?? ""
        self.values = try values.decodeIfPresent(String.self, forKey: .values) ?? ""
        motivations = try values.decodeIfPresent(String.self, forKey: .motivations) ?? ""
        relationship = try values.decodeIfPresent(String.self, forKey: .relationship) ?? ""
        speakingStyle = try values.decodeIfPresent(String.self, forKey: .speakingStyle) ?? ""
        knowledgeScope = try values.decodeIfPresent(String.self, forKey: .knowledgeScope) ?? ""
        boundaries = try values.decodeIfPresent(String.self, forKey: .boundaries) ?? ""
        shareWithOnlineModel = try values.decodeIfPresent(Bool.self, forKey: .shareWithOnlineModel) ?? false
    }

    private func nonempty(_ label: String, _ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : label + text
    }
}
