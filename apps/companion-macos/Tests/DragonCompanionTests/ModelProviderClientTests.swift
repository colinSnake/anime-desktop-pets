import Foundation
import CharacterCore
import XCTest
@testable import DragonCompanion

private final class ModelProviderURLProtocolStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try XCTUnwrap(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

final class ModelProviderClientTests: XCTestCase {
    override func tearDown() {
        ModelProviderURLProtocolStub.handler = nil
        super.tearDown()
    }

    func testCompletionUsesOpenAICompatibleChatEndpoint() async throws {
        var settings = ModelProviderSettings()
        settings.provider = "openai-compatible"
        settings.baseURL = "https://relay.example/v1"
        settings.model = "grok-3"
        var requests = 0
        ModelProviderURLProtocolStub.handler = { request in
            requests += 1
            XCTAssertEqual(request.url?.absoluteString, "https://relay.example/v1/chat/completions")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-key")
            let body = try requestBody(request)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(object["model"] as? String, "grok-3")
            let response = try JSONSerialization.data(withJSONObject: [
                "choices": [["message": ["content": "这是在线回复。"]]]
            ])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, response)
        }
        let session = makeSession()

        let result = try await ModelProviderClient(session: session).complete(
            settings: settings, apiKey: "test-key", userText: "你好", maxTokens: 8
        )

        XCTAssertEqual(result, "这是在线回复。")
        XCTAssertEqual(requests, 1)
    }

    func testCompletionSendsOnlyContextProvidedByCharacterPolicy() async throws {
        let settings = ModelProviderSettings()
        ModelProviderURLProtocolStub.handler = { request in
            let body = try requestBody(request)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
            let system = try XCTUnwrap(messages.first?["content"] as? String)
            XCTAssertTrue(system.contains("用户确认的稳定设定"))
            XCTAssertTrue(system.contains("confirmed preference"))
            XCTAssertFalse(system.contains("local-only secret"))
            let response = try JSONSerialization.data(withJSONObject: [
                "choices": [["message": ["content": "收到。"]]]
            ])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, response)
        }

        let result = try await ModelProviderClient(session: makeSession()).complete(
            settings: settings, apiKey: "test-key", userText: "我喜欢什么？",
            characterContext: "confirmed preference"
        )

        XCTAssertEqual(result, "收到。")
    }

    func testCompletionPayloadContainsOnlyRelevantAuthorizedMemory() async throws {
        let settings = ModelProviderSettings()
        let memories = [
            CharacterMemory(kind: .preference, text: "喜欢安静咖啡馆", source: "test", status: .confirmed,
                            shareWithOnlineModel: true),
            CharacterMemory(kind: .fact, text: "宠物名字是雪球", source: "test", status: .confirmed,
                            shareWithOnlineModel: true),
            CharacterMemory(kind: .fact, text: "喜欢安静酒吧", source: "test", status: .candidate,
                            shareWithOnlineModel: true),
            CharacterMemory(kind: .fact, text: "只留在本机的安静偏好", source: "test", status: .confirmed,
                            shareWithOnlineModel: false),
        ]
        let context = CharacterContextBuilder.make(identity: nil, memories: memories,
                                                   query: "推荐安静咖啡馆")
        ModelProviderURLProtocolStub.handler = { request in
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
            let system = try XCTUnwrap(messages.first?["content"] as? String)
            XCTAssertTrue(system.contains("喜欢安静咖啡馆"))
            XCTAssertFalse(system.contains("雪球"))
            XCTAssertFalse(system.contains("安静酒吧"))
            XCTAssertFalse(system.contains("只留在本机"))
            let data = try JSONSerialization.data(withJSONObject: [
                "choices": [["message": ["content": "可以试试安静的咖啡馆。"]]]
            ])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }

        let result = try await ModelProviderClient(session: makeSession()).complete(
            settings: settings, apiKey: "test-key", userText: "推荐安静咖啡馆", characterContext: context
        )

        XCTAssertEqual(result, "可以试试安静的咖啡馆。")
    }

    func testAuthorizedDefaultPersonaReachesMockedPayloadIncludingFinalBoundaries() async throws {
        var identity = CharacterIdentity.starter(name: "龙妹")
        identity.shareWithOnlineModel = true
        let context = CharacterContextBuilder.make(identity: identity, memories: [], query: "陪我聊聊")
        ModelProviderURLProtocolStub.handler = { request in
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
            let system = try XCTUnwrap(messages.first?["content"] as? String)
            XCTAssertTrue(system.contains(identity.promptText))
            let data = try JSONSerialization.data(withJSONObject: [
                "choices": [["message": ["content": "我在这里。"]]]]
            )
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        _ = try await ModelProviderClient(session: makeSession()).complete(
            settings: ModelProviderSettings(), apiKey: "synthetic-test-key", userText: "陪我聊聊", characterContext: context
        )
    }

    func testCredentialLikeSharedIdentityIsAbsentFromMockedRequestPayload() async throws {
        let settings = ModelProviderSettings()
        let identity = CharacterIdentity(name: "龙妹", personality: "API key: identity-secret-sentinel",
                                         values: "诚实", shareWithOnlineModel: true)
        let context = CharacterContextBuilder.make(identity: identity, memories: [], query: "普通聊天")
        XCTAssertNil(context)

        ModelProviderURLProtocolStub.handler = { request in
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
            let system = try XCTUnwrap(messages.first?["content"] as? String)
            XCTAssertFalse(system.contains("identity-secret-sentinel"))
            XCTAssertFalse(system.contains("核心价值观：诚实"))
            let data = try JSONSerialization.data(withJSONObject: [
                "choices": [["message": ["content": "收到。"]]]
            ])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }

        let result = try await ModelProviderClient(session: makeSession()).complete(
            settings: settings, apiKey: "test-key", userText: "普通聊天", characterContext: context
        )

        XCTAssertEqual(result, "收到。")
    }

    func testWeatherToolUsesOpenMeteoThenReturnsResultToModel() async throws {
        let settings = ModelProviderSettings()
        var requestCount = 0
        ModelProviderURLProtocolStub.handler = { request in
            requestCount += 1
            let url = try XCTUnwrap(request.url)
            let payload: [String: Any]
            if url.host == "api.openai.com" {
                let body = try requestBody(request)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
                if requestCount == 1 {
                    XCTAssertNotNil(object["tools"])
                    XCTAssertEqual(messages.last?["content"] as? String, "北京今天天气怎么样？")
                    payload = ["choices": [["message": ["tool_calls": [[
                        "id": "weather-1",
                        "type": "function",
                        "function": ["name": "get_current_weather", "arguments": "{\"city\":\"北京\"}"]
                    ]]]]]]
                } else {
                    XCTAssertTrue(messages.contains { ($0["role"] as? String) == "tool" })
                    payload = ["choices": [["message": ["content": "北京现在晴朗，气温20°C。"]]]]
                }
            } else if url.host == "geocoding-api.open-meteo.com" {
                XCTAssertTrue(url.absoluteString.contains("name=%E5%8C%97%E4%BA%AC"))
                payload = ["results": [["name": "北京", "latitude": 39.9, "longitude": 116.4]]]
            } else if url.host == "api.open-meteo.com" {
                payload = ["current": ["temperature_2m": 20, "apparent_temperature": 19,
                                        "weather_code": 0, "relative_humidity_2m": 40,
                                        "wind_speed_10m": 5]]
            } else {
                throw URLError(.unsupportedURL)
            }
            let data = try JSONSerialization.data(withJSONObject: payload)
            return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }

        let result = try await ModelProviderClient(session: makeSession()).complete(
            settings: settings, apiKey: "test-key", userText: "北京今天天气怎么样？"
        )

        XCTAssertEqual(result, "北京现在晴朗，气温20°C。")
        XCTAssertEqual(requestCount, 4)
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ModelProviderURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    func testCompletionCarriesOnlyBoundedInMemoryChatHistory() async throws {
        let settings = ModelProviderSettings()
        ModelProviderURLProtocolStub.handler = { request in
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
            XCTAssertEqual(messages.map { $0["role"] as? String }, ["system", "user", "assistant", "user"])
            XCTAssertEqual(messages[1]["content"] as? String, "上一轮问题")
            XCTAssertEqual(messages[2]["content"] as? String, "上一轮回答")
            XCTAssertEqual(messages[3]["content"] as? String, "继续聊")
            let data = try JSONSerialization.data(withJSONObject: [
                "choices": [["message": ["content": "好的，我们继续。"]]]
            ])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }

        let result = try await ModelProviderClient(session: makeSession()).complete(
            settings: settings, apiKey: "test-key", userText: "继续聊",
            history: [
                CharacterChatTurn(role: .user, text: "上一轮问题"),
                CharacterChatTurn(role: .assistant, text: "上一轮回答")
            ]
        )

        XCTAssertEqual(result, "好的，我们继续。")
    }

}
