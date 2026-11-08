import XCTest
@testable import DragonCompanion

private final class ModelProviderURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                       httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func requestBodyData(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
    defer { buffer.deallocate() }
    while stream.hasBytesAvailable {
        let count = stream.read(buffer, maxLength: 4_096)
        if count <= 0 { break }
        data.append(buffer, count: count)
    }
    return data.isEmpty ? nil : data
}

final class ModelProviderTests: XCTestCase {
    func testDefaultsToOpenAIChatCompletions() throws {
        let settings = ModelProviderSettings()
        try settings.validate()
        XCTAssertEqual(settings.completionURL?.absoluteString, "https://api.openai.com/v1/chat/completions")
    }

    func testDeepSeekAndRelayEndpoints() throws {
        var settings = ModelProviderSettings()
        settings.provider = "deepseek"
        settings.baseURL = "https://api.deepseek.com"
        settings.model = "deepseek-chat"
        try settings.validate()
        XCTAssertEqual(settings.completionURL?.absoluteString, "https://api.deepseek.com/chat/completions")

        settings.provider = "openai-compatible"
        settings.baseURL = "https://relay.example/v1/"
        settings.model = "grok-3"
        try settings.validate()
        XCTAssertEqual(settings.completionURL?.absoluteString, "https://relay.example/v1/chat/completions")
    }

    func testRejectsInsecureRemoteURLsAndEmbeddedCredentials() {
        var settings = ModelProviderSettings()
        settings.baseURL = "http://relay.example/v1"
        XCTAssertThrowsError(try settings.validate())
        settings.baseURL = "https://user:pass@relay.example/v1"
        XCTAssertThrowsError(try settings.validate())
        settings.baseURL = "https://relay.example/v1?token=secret"
        XCTAssertThrowsError(try settings.validate())
    }

    func testStoreRoundTripsProviderWithoutAPIKey() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ModelProviderStore(stateDirectory: directory)
        var settings = ModelProviderSettings()
        settings.provider = "openai-compatible"
        settings.baseURL = "https://relay.example/v1"
        settings.model = "grok-3"
        try store.save(settings)

        XCTAssertEqual(try store.load(), settings)
        let saved = try String(contentsOf: store.fileURL, encoding: .utf8)
        XCTAssertFalse(saved.localizedCaseInsensitiveContains("api_key"))
        XCTAssertFalse(saved.localizedCaseInsensitiveContains("secret"))
    }

    func testGoalSuggestionSendsOnlyConfirmedGoalTextAndParsesJSON() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ModelProviderURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = ModelProviderClient(session: session)
        var settings = ModelProviderSettings()
        settings.provider = "openai-compatible"
        settings.baseURL = "https://relay.example/v1"
        settings.model = "test-model"

        ModelProviderURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://relay.example/v1/chat/completions")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-key")
            let payload = try! JSONSerialization.jsonObject(with: requestBodyData(request)!) as! [String: Any]
            let messages = payload["messages"] as! [[String: String]]
            XCTAssertEqual(messages.count, 2)
            XCTAssertTrue(messages[0]["content"]!.contains("仅返回 JSON"))
            XCTAssertEqual(messages[1]["content"], "目标名称：整理个人作品集\n目标说明：完成一个可展示的网页")
            XCTAssertFalse(messages.map { $0["content"] ?? "" }.joined().contains("身份资料"))
            return (200, Data(#"{"choices":[{"message":{"content":"{\"steps\":[\"整理项目\",\"制作页面\"]}"}}]}"#.utf8))
        }
        defer { ModelProviderURLProtocol.handler = nil }

        let draft = try await client.suggestGoalSteps(settings: settings, apiKey: "test-key",
                                                      title: "整理个人作品集", details: "完成一个可展示的网页")
        XCTAssertEqual(draft.steps, ["整理项目", "制作页面"])
        XCTAssertEqual(draft.title, "整理个人作品集")
        XCTAssertEqual(draft.details, "完成一个可展示的网页")
    }

    func testGoalSuggestionRejectsMalformedOrExcessiveDrafts() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ModelProviderURLProtocol.self]
        let client = ModelProviderClient(session: URLSession(configuration: config))
        let settings = ModelProviderSettings()

        for content in ["not json", "{\"steps\":[]}",
                        "{\"steps\":[\(Array(repeating: "\"step\"", count: 13).joined(separator: ","))]}"] {
            ModelProviderURLProtocol.handler = { _ in
                let response: [String: Any] = ["choices": [["message": ["content": content]]]]
                return (200, try! JSONSerialization.data(withJSONObject: response))
            }
            do {
                _ = try await client.suggestGoalSteps(settings: settings, apiKey: "test-key",
                                                      title: "有效目标", details: "")
                XCTFail("Expected malformed or excessive draft to fail")
            } catch is ModelProviderError {
                continue
            }
        }
        ModelProviderURLProtocol.handler = nil
    }

    func testGoalSuggestionRejectsOversizedResponse() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ModelProviderURLProtocol.self]
        let client = ModelProviderClient(session: URLSession(configuration: config))
        ModelProviderURLProtocol.handler = { _ in
            (200, Data(repeating: 0x20, count: 64 * 1024 + 1))
        }
        defer { ModelProviderURLProtocol.handler = nil }

        do {
            _ = try await client.suggestGoalSteps(settings: ModelProviderSettings(), apiKey: "test-key",
                                                  title: "有效目标", details: "")
            XCTFail("Oversized model responses must be rejected")
        } catch is ModelProviderError {
            return
        }
    }
}
