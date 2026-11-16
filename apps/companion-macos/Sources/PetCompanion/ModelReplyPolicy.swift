import Foundation

/// Text chat and spoken replies share transport, but not output budgets or prose.
enum ModelReplyPurpose {
    case speech
    case textChat

    var tokenBudget: Int { self == .textChat ? 2_048 : 160 }
    var timeout: TimeInterval { self == .textChat ? 60 : 25 }
    var instruction: String {
        self == .textChat
            ? "这是文字聊天。按问题需要给出完整、清晰的回答，可以分段和列出步骤；不要为了适合朗读而截断解释。"
            : "回复适合朗读，控制在80个汉字以内。"
    }

    func displayText(_ content: String, finishReason: String?) throws -> String {
        let clean = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw ModelProviderError.invalidResponse }
        guard self == .textChat else { return String(clean.prefix(100)) }
        return finishReason == "length" ? clean + "\n\n（已达到模型回复长度上限，可继续追问未完成的部分。）" : clean
    }
}
