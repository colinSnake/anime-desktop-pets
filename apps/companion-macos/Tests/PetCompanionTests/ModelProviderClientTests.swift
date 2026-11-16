import Foundation
import CharacterCore
import XCTest
@testable import PetCompanion

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

    func testPayloadContainsAuthorizedGoalsAndCurrentReviewedKnowledgeOnly() async throws {
        let goals = [CharacterGoal(title: "书房整理", steps: [.init(text: "标签分类")], shareWithOnlineModel: true),
                     CharacterGoal(title: "书房私密计划", steps: [.init(text: "私人步骤")]),
                     CharacterGoal(title: "书房凭证", details: "密码：synthetic", shareWithOnlineModel: true)]
        let memories = [CharacterMemory(kind: .knowledge, text: "书房当前知识", source: "合成手册", status: .confirmed, shareWithOnlineModel: true),
                        CharacterMemory(kind: .knowledge, text: "书房过期知识", source: "旧手册", status: .confirmed, shareWithOnlineModel: true, expiresAt: .now.addingTimeInterval(-60)),
                        CharacterMemory(kind: .knowledge, text: "书房待审知识", source: "草稿", shareWithOnlineModel: true)]
        let context = CharacterContextBuilder.make(identity: nil, memories: memories, goals: goals, query: "书房整理")
        var requests = 0
        ModelProviderURLProtocolStub.handler = { request in
            requests += 1
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
            let system = try XCTUnwrap(messages.first?["content"] as? String)
            XCTAssertTrue(system.contains("标签分类")); XCTAssertTrue(system.contains("书房当前知识"))
            XCTAssertTrue(system.contains("不得声称已经执行、推进或修改计划"))
            for excluded in ["私人步骤", "书房凭证", "synthetic", "书房过期知识", "书房待审知识"] {
                XCTAssertFalse(system.contains(excluded), excluded)
            }
            let data = try JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": "收到。"]]]])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        _ = try await ModelProviderClient(session: makeSession()).complete(settings: ModelProviderSettings(), apiKey: "synthetic-test-key",
                                                                          userText: "书房整理", characterContext: context)
        XCTAssertEqual(requests, 1)
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

extension ModelProviderClientTests {
    func testTextChatPreservesLongReplyAndHasIndependentPromptAndBudget() async throws {
        let reply = String(repeating: "完整文字答复。", count: 300)
        ModelProviderURLProtocolStub.handler = { request in
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            XCTAssertEqual(payload["max_tokens"] as? Int, 2_048)
            let messages = try XCTUnwrap(payload["messages"] as? [[String: Any]])
            XCTAssertFalse((messages.first?["content"] as? String ?? "").contains("80个汉字"))
            let data = try JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": reply], "finish_reason": "stop"]]])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        let result = try await ModelProviderClient(session: makeSession()).complete(
            settings: ModelProviderSettings(), apiKey: "synthetic", userText: "详细解释", purpose: .textChat)
        XCTAssertEqual(result, reply)
    }

    func testTextChatFallbackPreservesReplyAndReportsServerLengthLimit() async throws {
        var count = 0
        let reply = String(repeating: "详细内容", count: 350)
        ModelProviderURLProtocolStub.handler = { request in
            count += 1
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            if count == 1 {
                return (HTTPURLResponse(url: request.url!, statusCode: 422, httpVersion: nil, headerFields: nil)!, Data())
            }
            XCTAssertNil(payload["tools"])
            XCTAssertEqual(payload["max_tokens"] as? Int, 2_048)
            let data = try JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": reply], "finish_reason": "length"]]])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        let result = try await ModelProviderClient(session: makeSession()).complete(
            settings: ModelProviderSettings(), apiKey: "synthetic", userText: "详细解释", purpose: .textChat)
        XCTAssertTrue(result.hasPrefix(reply))
        XCTAssertTrue(result.contains("回复长度上限"))
        XCTAssertEqual(count, 2)
    }
}

extension ModelProviderClientTests {
    func testModelDiscoveryUsesModelsEndpointAndFiltersDuplicateOrInvalidIDs() async throws {
        var settings = ModelProviderSettings()
        settings.baseURL = "https://synthetic.invalid/custom/v1/chat/completions/"
        ModelProviderURLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://synthetic.invalid/custom/v1/models")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic")
            XCTAssertNil(request.httpBody)
            let data = try JSONSerialization.data(withJSONObject: ["data": [["id": " model-b "], ["id": "model-a"], ["id": "model-a"], ["id": "\n"], ["id": "bad\nid"]]])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        let models = try await ModelDiscoveryClient(session: makeSession()).fetchModels(settings: settings, apiKey: "synthetic")
        XCTAssertEqual(models, ["model-a", "model-b"])
    }

    func testModelDiscoveryFailureDoesNotBecomeAnEmptySuccessfulList() async throws {
        for (status, data) in [(404, Data()), (200, Data(#"{"data":[]}"#.utf8)), (200, Data(#"{"wrong":[]}"#.utf8))] {
            ModelProviderURLProtocolStub.handler = { request in
                (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, data)
            }
            do {
                _ = try await ModelDiscoveryClient(session: makeSession()).fetchModels(settings: ModelProviderSettings(), apiKey: "synthetic")
                XCTFail("Unsupported or empty discovery must leave manual choices available")
            } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        }
    }
}

extension ModelProviderClientTests {
    func testMemoryReviewHasIsolatedBoundedUserOnlyRequestAndValidatesOutput() async throws {
        let turn = CharacterChatTurn(role: .user, text: "我喜欢合成绿茶")
        var requests = 0
        var malformed = false
        ModelProviderURLProtocolStub.handler = { request in
            requests += 1
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            XCTAssertNil(object["tools"])
            XCTAssertNil(object["tool_choice"])
            XCTAssertEqual(object["max_tokens"] as? Int, 1600)
            let messages = try XCTUnwrap(object["messages"] as? [[String: String]])
            XCTAssertEqual(messages.count, 2)
            let content = try XCTUnwrap(messages.last?["content"])
            XCTAssertTrue(content.contains(turn.text))
            XCTAssertFalse(content.contains("不应外发的助手内容"))
            XCTAssertFalse(content.contains("我的密码是合成数据"))
            let result = malformed ? "not-json" : "{\"suggestions\":[{\"turnID\":\"\(turn.id.uuidString)\",\"kind\":\"preference\",\"quote\":\"\(turn.text)\",\"confidence\":0.96}]}"
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                    try JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": result]]]]))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ModelProviderURLProtocolStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = ModelProviderClient(session: session)
        var settings = ModelProviderSettings()
        settings.baseURL = "https://synthetic.invalid/v1"
        settings.model = "synthetic"
        let turns = [turn, CharacterChatTurn(role: .assistant, text: "不应外发的助手内容"),
                     CharacterChatTurn(role: .user, text: "我的密码是合成数据")]
        let result = try await client.reviewMemories(settings: settings, apiKey: "synthetic", turns: turns)
        XCTAssertEqual(result.first?.memory.text, turn.text)
        malformed = true
        do { _ = try await client.reviewMemories(settings: settings, apiKey: "synthetic", turns: turns); XCTFail("拒绝无效输出") } catch {}
        _ = try await client.reviewMemories(settings: settings, apiKey: "synthetic", turns: [turns[1], turns[2]])
        XCTAssertEqual(requests, 2)
    }
    func testSingleRequestHasNoToolsHistoryOrRetry() async throws {
        var count = 0
        ModelProviderURLProtocolStub.handler = { request in
            count += 1
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])
            XCTAssertNil(body["tools"])
            let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
            XCTAssertEqual(messages.count, 2)
            XCTAssertEqual(messages.last?["content"], "idle")
            return (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, Data())
        }
        do {
            _ = try await ModelProviderClient(session: makeSession()).singleReply(settings: ModelProviderSettings(), apiKey: "synthetic", system: "只输出一句陪伴", user: "idle", maxTokens: 100, timeout: 8)
            XCTFail("reject service failure")
        } catch {}
        XCTAssertEqual(count, 1)
    }

}
