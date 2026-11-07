import XCTest
@testable import DragonCompanion

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
}
