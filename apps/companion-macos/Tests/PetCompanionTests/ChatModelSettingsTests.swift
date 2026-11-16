import CharacterCore
import XCTest
@testable import PetCompanion

final class ChatModelSettingsTests: XCTestCase {
    func testLegacySettingsDecodeWithOnlyTheConfiguredDefault() throws {
        let data = Data(#"{"provider":"openai-compatible","baseURL":"https://relay.example/v1","model":"custom-a"}"#.utf8)
        let settings = try JSONDecoder().decode(ModelProviderSettings.self, from: data)
        XCTAssertEqual(settings.chatCatalog.models, ["custom-a"])
    }

    func testCatalogDeduplicatesAndAlwaysIncludesDefault() throws {
        var settings = ModelProviderSettings()
        settings.model = "custom-a"
        settings.availableModels = ["custom-b", "custom-a", "custom-b"]
        try settings.validate()
        XCTAssertEqual(settings.chatCatalog.models, ["custom-a", "custom-b"])
        let choice = CharacterChatModelSelection(model: "custom-b", serviceID: settings.chatCatalog.serviceID)
        let selected = try settings.selectingChatModel(choice)
        XCTAssertEqual(selected.model, "custom-b")
        XCTAssertEqual(settings.model, "custom-a", "Chat selection must not mutate the global default")
    }

    func testRejectsUnknownModelsAndSelectionsFromAnotherService() {
        var settings = ModelProviderSettings()
        settings.availableModels = ["custom-b"]
        XCTAssertThrowsError(try settings.selectingChatModel(.init(model: "unknown", serviceID: settings.chatCatalog.serviceID)))
        XCTAssertThrowsError(try settings.selectingChatModel(.init(model: "custom-b", serviceID: "another-service")))
        settings.availableModels = [""]
        XCTAssertThrowsError(try settings.validate())
        settings.availableModels = [String(repeating: "x", count: 257)]
        XCTAssertThrowsError(try settings.validate())
        settings.availableModels = (0..<33).map { "model-\($0)" }
        XCTAssertThrowsError(try settings.validate())
    }

    func testStoreRoundTripsModelListWithoutCredentials() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = ModelProviderStore(stateDirectory: dir)
        XCTAssertNil(try store.loadChatCatalog(), "Defaults are not a saved configuration")
        var settings = ModelProviderSettings()
        settings.availableModels = ["custom-b", "custom-c"]
        try store.save(settings)
        XCTAssertEqual(try store.load(), settings)
        XCTAssertEqual(try store.loadChatCatalog(), settings.chatCatalog)
    }
}
