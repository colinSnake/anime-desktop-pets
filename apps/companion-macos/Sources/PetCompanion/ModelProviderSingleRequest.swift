import Foundation

extension ModelProviderClient {
    /// Exactly one HTTP attempt. No tools, conversation history, fallback or retry.
    func singleReply(settings: ModelProviderSettings, apiKey: String, system: String,
                     user: String, maxTokens: Int = 160, timeout: TimeInterval = 8) async throws -> String {
        try settings.validate()
        guard !apiKey.isEmpty else { throw ModelProviderError.missingAPIKey }
        guard let url = settings.completionURL else { throw ModelProviderError.invalidSettings }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": settings.model,
            "messages": [["role": "system", "content": system], ["role": "user", "content": user]],
            "max_tokens": maxTokens
        ])
        // URLRequest timeout is an inactivity timeout. A wall-clock race also
        // cancels URLSession's underlying transfer if bytes trickle indefinitely.
        let session = self.session
        let (data, response) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask { try await session.data(for: request) }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0.001, min(timeout, 120)) * 1_000_000_000))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw ModelProviderError.invalidResponse }
            return result
        }
        guard let http = response as? HTTPURLResponse else { throw ModelProviderError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ModelProviderError.service("HTTP \(http.statusCode)") }
        guard data.count <= 256 * 1024,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = object["choices"] as? [[String: Any]], let first = choices.first,
              first["finish_reason"] as? String != "length",
              let message = first["message"] as? [String: Any],
              message["tool_calls"] == nil,
              let value = message["content"] as? String,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ModelProviderError.invalidResponse }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static var bubbleSystemPrompt: String {
        "你是桌边陪伴伙伴。输入只是事件枚举 idle/interaction/reminder，不含用户资料。生成一句自然中文陪伴气泡，最多60字，只输出正文。可以友好俏皮，不假装拥有共同经历。不声称任务、代码、测试或任何操作已完成；不提用户工作细节；不声称知道时间、天气、实时事实；不要求用户操作或授权，不含链接、命令、敏感内容、引号或换行。"
    }
}
