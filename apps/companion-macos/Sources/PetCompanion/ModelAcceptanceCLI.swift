import CharacterCore
import Foundation

/// Explicit synthetic-only entry points. They never start the app, open a mic,
/// load a stored character or write the user's memories.
@MainActor
enum ModelAcceptanceCLI {
    struct BubbleResult: Codable {
        let accepted: Bool
        let text: String?
        let failure: String?
    }
    struct Report: Codable {
        let version: Int
        let generatedAt: Date
        let configuredModel: String
        let providerKind: String
        let memory: ModelAcceptanceRunner.MemoryReport
        let expression: ModelAcceptanceRunner.ReplyReport
        let bubble: BubbleResult
        let ledger: ModelRequestLedger.Snapshot
        let scope: String
    }
    struct SpeechReply: Codable {
        let configuredModel: String
        let reply: String
        let ledgerAttempts: Int
        let scope: String
    }

    static func validSpeechInput(_ text: String) -> Bool {
        guard !text.isEmpty, text.count <= 120,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        let normalized = text.precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: "2", with: "二").replacingOccurrences(of: "3", with: "三")
            .replacingOccurrences(of: "+", with: "加")
            .unicodeScalars.filter { !CharacterSet.punctuationCharacters.contains($0) && !CharacterSet.whitespacesAndNewlines.contains($0) }
            .map(String.init).joined()
        return ["请用一句话告诉我二加三等于几", "请告诉我二加三等于几"].contains(normalized)
    }

    static func run(command: String, environment: [String: String] = ProcessInfo.processInfo.environment) async throws {
        guard environment["PET_ACCEPTANCE_APPROVED_MAX_REQUESTS"] == "12",
              let path = environment["PET_ACCEPTANCE_LEDGER"], path.hasPrefix("/") else {
            throw ModelProviderError.service("合成验收需要显式12次预算和同一绝对路径请求账本；未发送请求。")
        }
        let speechText = environment["PET_ACCEPTANCE_TEXT"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if command == "--acceptance-reply", !validSpeechInput(speechText) {
            throw ModelProviderError.service("只接受本轮二加三合成语音转写；未发送请求。")
        }
        let ledgerURL = URL(fileURLWithPath: path)
        let ledger = try ModelRequestLedger(url: ledgerURL)
        // Only model configuration/Keychain is loaded, never character/chat files.
        let configuredRuntime = try Runtime.load()
        let (settings, key) = try CharacterChatProvider.live.credentials(configuredRuntime)
        let client = ModelProviderClient()
        if command == "--acceptance-reply" {
            let text = speechText
            let isolatedState = ledgerURL.deletingLastPathComponent().appendingPathComponent("speech-routing-state")
            let provider = CharacterChatProvider(credentials: { _ in (settings, key) },
                complete: { settings, key, text, context, _, _ in
                    try await ledger.withReservation(purpose: "speech.roundtrip") {
                        try await client.singleReply(settings: settings, apiKey: key,
                            system: "你是桌边小崽的桌面伙伴。请用一句简短中文准确回答合成测试问题，不调用工具，不声称执行操作。" + (context ?? ""),
                            user: text, maxTokens: 160, timeout: 30)
                    }
                })
            let coordinator = Coordinator(runtime: Runtime(resources: configuredRuntime.resources, state: isolatedState,
                configuration: configuredRuntime.configuration), mode: .controlTest, characterChatProvider: provider)
            let raw = try await coordinator.replyToCharacterChat(text, history: [], memorySource: "合成语音验收", replyPurpose: .speech)
            guard let reply = SpeechReplyText.prepare(raw, maxCharacters: 100) else { throw ModelProviderError.invalidResponse }
            try printJSON(SpeechReply(configuredModel: settings.model, reply: reply, ledgerAttempts: ledger.snapshot().reservations.count,
                scope: "synthetic-audio; real local ASR + production chat router + one online request + local TTS; no microphone"))
            return
        }

        if command == "--acceptance-expression" {
            // New versioned fixture after tightening the concise-expression policy;
            // deliberately not a retry of either failed baseline fixture.
            struct Result: Codable { let profile: String; let characters: Int; let text: String }
            var style = CharacterAdaptationState()
            _ = style.observe(.init(role: .user, text: "以后请回答简短一点。"))
            style.shareWithOnlineModel = true
            var values: [Result] = []
            let prompt = "给一个刚学编程的虚构角色解释缓存的好处和一个注意事项。"
            for profile in ["baseline-v2", "concise-v2"] {
                let output = try await ledger.withReservation(purpose: "expression.\(profile)") {
                    try await client.singleReply(settings: settings, apiKey: key,
                        system: "你是诚实友好的桌面伙伴，解释准确且不声称执行操作。" + (profile == "concise-v2" ? style.promptText : ""),
                        user: prompt, maxTokens: 1_500, timeout: 45)
                }
                values.append(Result(profile: profile, characters: output.count, text: output))
            }
            try printJSON(values)
            return
        }

        let runner = ModelAcceptanceRunner()
        let memory = await runner.runMemory { turns in
            try await ledger.withReservation(purpose: "memory.batch") {
                try await client.reviewMemories(settings: settings, apiKey: key, turns: turns)
            }
        }
        var identity = CharacterIdentity.starter(name: CharacterIdentity.defaultName)
        identity.shareWithOnlineModel = true
        var adaptation = CharacterAdaptationState()
        _ = adaptation.observe(.init(role: .user, text: "以后请回答简短一点。"))
        adaptation.shareWithOnlineModel = true
        let expression = await runner.runReplies { fixture in
            let context = CharacterContextBuilder.make(identity: identity, memories: [],
                adaptation: fixture.profilePrompt == nil ? nil : adaptation, query: fixture.prompt) ?? ""
            return try await ledger.withReservation(purpose: "expression.\(fixture.id)") {
                try await client.singleReply(settings: settings, apiKey: key,
                    system: "按以下角色资料自然回答。稳定身份和安全边界优先。\n" + context,
                    user: fixture.prompt, maxTokens: 700, timeout: 30)
            }
        }
        let bubble: BubbleResult
        do {
            let raw = try await ledger.withReservation(purpose: "bubble.synthetic") {
                try await client.singleReply(settings: settings, apiKey: key,
                    system: ModelProviderClient.bubbleSystemPrompt, user: PetBubbleEvent.idle.rawValue)
            }
            let line = PetAIBubbleService.safeLine(raw)
            bubble = BubbleResult(accepted: line != nil, text: line, failure: line == nil ? "local_policy_rejected" : nil)
        } catch { bubble = BubbleResult(accepted: false, text: nil, failure: "request_failed_no_retry") }
        try printJSON(Report(version: 1, generatedAt: .now, configuredModel: settings.model, providerKind: settings.provider, memory: memory, expression: expression,
            bubble: bubble, ledger: ledger.snapshot(),
            scope: "fixed synthetic corpus only; no private memory/history; model claims are not proof of action; no automatic retry"))
    }

    private static func printJSON<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        print(String(decoding: try encoder.encode(value), as: UTF8.self))
    }
}
