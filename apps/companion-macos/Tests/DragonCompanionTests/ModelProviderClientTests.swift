import Foundation
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

}
