import Foundation

/// Discovery is an explicit GET, never a completion or an automatic page side effect.
struct ModelDiscoveryClient {
    var session: URLSession = .shared

    func fetchModels(settings: ModelProviderSettings, apiKey: String) async throws -> [String] {
        try settings.validate()
        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ModelProviderError.missingAPIKey }
        guard let completion = settings.completionURL else { throw ModelProviderError.invalidSettings }
        let url = completion.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("models")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "GET"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Do not replay credentials at a redirect destination chosen by a service.
        let (data, response) = try await session.data(for: request, delegate: ModelDiscoveryRedirectPolicy())
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw ModelProviderError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ModelProviderError.service("无法获取模型列表（HTTP \(http.statusCode)），可继续手工填写模型 ID。")
        }
        guard data.count <= 1_048_576,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = object["data"] as? [[String: Any]], rows.count <= 10_000 else {
            throw ModelProviderError.invalidResponse
        }
        let models = Set(rows.compactMap { $0["id"] as? String }.map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty && $0.utf8.count <= 256 && !$0.contains(where: \.isNewline) }).sorted()
        guard !models.isEmpty else {
            throw ModelProviderError.service("服务没有返回可用的模型 ID，可继续手工填写。")
        }
        return models
    }
}

final class ModelDiscoveryRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
