import Foundation

/// An explicit merge proposal. Reading an older profile never mutates it.
public enum CharacterIdentityCompletion {
    public struct Field: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let value: String
    }

    private static let fields: [(String, String, WritableKeyPath<CharacterIdentity, String>)] = [
        ("role", "身份定位", \.role), ("background", "背景", \.background),
        ("personality", "性格", \.personality), ("values", "核心价值观", \.values),
        ("motivations", "愿望与方向", \.motivations), ("relationship", "与用户的关系", \.relationship),
        ("speakingStyle", "表达方式", \.speakingStyle), ("knowledgeScope", "知识与擅长边界", \.knowledgeScope),
        ("boundaries", "边界", \.boundaries)
    ]

    public static func proposedFields(for identity: CharacterIdentity, defaultName: String) -> [Field] {
        let preset = CharacterIdentity.starter(name: defaultName)
        return fields.compactMap { id, title, key in
            guard identity[keyPath: key].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !preset[keyPath: key].isEmpty else { return nil }
            return Field(id: id, title: title, value: preset[keyPath: key])
        }
    }

    public static func fillingBlanks(in identity: CharacterIdentity, defaultName: String) -> CharacterIdentity {
        var result = identity
        let preset = CharacterIdentity.starter(name: defaultName)
        for (_, _, key) in fields where result[keyPath: key].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result[keyPath: key] = preset[keyPath: key]
        }
        return result
    }
}
