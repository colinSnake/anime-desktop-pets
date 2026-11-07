import Foundation

public struct CharacterIdentity: Codable, Equatable, Sendable {
    public var name: String
    public var background: String
    public var personality: String
    public var speakingStyle: String
    public var boundaries: String
    public var shareWithOnlineModel: Bool

    public init(name: String, background: String = "", personality: String = "",
                speakingStyle: String = "", boundaries: String = "",
                shareWithOnlineModel: Bool = false) {
        self.name = name
        self.background = background
        self.personality = personality
        self.speakingStyle = speakingStyle
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
            nonempty("背景：", background),
            nonempty("性格：", personality),
            nonempty("表达方式：", speakingStyle),
            nonempty("边界：", boundaries),
        ].compactMap { $0 }.joined(separator: "\n")
    }

    private func nonempty(_ label: String, _ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : label + text
    }
}
