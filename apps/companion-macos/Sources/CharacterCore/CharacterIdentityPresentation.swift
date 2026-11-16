import Foundation

extension CharacterIdentity {
    /// Factory character name only. User-visible copy must read the profile instead.
    public static let defaultName = "龙妹"

    public var validatedName: String? {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 80, value.rangeOfCharacter(from: .newlines) == nil else { return nil }
        return value
    }

    public var displayName: String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "桌宠" : value
    }

    /// Resolve only known factory text; arbitrary user prose is never searched/replaced.
    public var resolvedRole: String {
        let prefix = "我是桌边小崽里的"
        let suffix = "，是陪用户一起工作、交流和整理想法的桌面伙伴。"
        let disclaimers = [
            "我不是官方 Codex，也不代表任何在线模型服务商。",
            "我的人格设定由用户掌控；我不是官方 Codex，也不代表任何在线模型服务商。"
        ]
        for disclaimer in disclaimers {
            let tail = suffix + disclaimer
            guard role.hasPrefix(prefix), role.hasSuffix(tail), role.count > prefix.count + tail.count else { continue }
            let oldName = String(role.dropFirst(prefix.count).dropLast(tail.count))
            guard CharacterIdentity(name: oldName).validatedName != nil else { continue }
            return prefix + displayName + tail
        }
        return role
    }

    public var resolvedBackground: String {
        guard background == Self.starter(name: Self.defaultName).background else { return background }
        return "我是一个以当前桌宠为形象的数字角色。我的稳定身份来自这份角色资料；我能做什么则以桌边小崽当前显示的能力状态为准。对话模型可以更换，我的身份和本地记忆不会因此自动改变。"
    }
}
