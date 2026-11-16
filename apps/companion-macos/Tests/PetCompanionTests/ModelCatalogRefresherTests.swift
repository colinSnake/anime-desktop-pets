import CharacterCore
import Foundation
import XCTest
@testable import PetCompanion

@MainActor
final class ModelCatalogRefresherTests: XCTestCase {
    func testDiscoveryMergesManualChoicesWithoutChangingDefault() async throws {
        var stored = ModelProviderSettings()
        stored.availableModels = ["manual-model"]
        let original = stored
        var saves = 0
        let refresher = ModelCatalogRefresher(load: { stored }, save: { stored = $0; saves += 1 }, readKey: { "synthetic" }, discover: { _, _ in ["found-a", "found-b"] })
        let result = try await refresher.refresh(expectedServiceID: original.chatCatalog.serviceID)
        XCTAssertEqual(saves, 1)
        XCTAssertEqual(stored.model, original.model)
        XCTAssertEqual(result.models, [original.model, "manual-model", "found-a", "found-b"])
    }

    func testChangedSettingsDiscardLateDiscoveryWithoutSaving() async throws {
        var stored = ModelProviderSettings()
        let original = stored
        var saves = 0
        let refresher = ModelCatalogRefresher(load: { stored }, save: { _ in saves += 1 }, readKey: { "synthetic" }, discover: { _, _ in
            stored.baseURL = "https://new-service.invalid/v1"
            return ["old-service-model"]
        })
        do { _ = try await refresher.refresh(expectedServiceID: original.chatCatalog.serviceID); XCTFail("Must reject stale results") }
        catch { XCTAssertTrue(error.localizedDescription.contains("更改")) }
        XCTAssertEqual(saves, 0)
        XCTAssertFalse(stored.availableModels.contains("old-service-model"))
    }

    func testStaleServiceIsRejectedBeforeReadingKeyOrNetwork() async throws {
        let refresher = ModelCatalogRefresher(load: { ModelProviderSettings() }, save: { _ in XCTFail("No save") }, readKey: { XCTFail("No credentials"); return "synthetic" }, discover: { _, _ in XCTFail("No network"); return [] })
        do { _ = try await refresher.refresh(expectedServiceID: "old-service"); XCTFail("Must reject stale service") }
        catch { XCTAssertTrue(error.localizedDescription.contains("更改")) }
    }

    func testFailedDiscoveryKeepsManualSettingsAndMergeStaysWithinLimit() async throws {
        var settings = ModelProviderSettings()
        settings.availableModels = ["manual"]
        let snapshot = settings
        let refresher = ModelCatalogRefresher(load: { settings }, save: { settings = $0 }, readKey: { "synthetic" }, discover: { _, _ in throw URLError(.timedOut) })
        do { _ = try await refresher.refresh(expectedServiceID: snapshot.chatCatalog.serviceID); XCTFail("Expected error") } catch {}
        XCTAssertEqual(settings, snapshot)
        let merged = try snapshot.mergingDiscoveredModels((0..<80).map { "model-\($0)" })
        XCTAssertEqual(merged.model, snapshot.model)
        XCTAssertEqual(merged.availableModels.first, "manual")
        XCTAssertEqual(merged.availableModels.count, 32)
        try merged.validate()
    }
}

extension ModelCatalogRefresherTests {
    func testDiscoveryRedirectPolicyNeverForwardsCredentials() throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: URL(string: "https://synthetic.invalid/models")!)
        let redirect = HTTPURLResponse(url: task.originalRequest!.url!, statusCode: 302, httpVersion: nil, headerFields: ["Location": "https://other.invalid/models"])!
        var forwarded = false
        ModelDiscoveryRedirectPolicy().urlSession(session, task: task, willPerformHTTPRedirection: redirect,
            newRequest: URLRequest(url: URL(string: "https://other.invalid/models")!)) { request in forwarded = request != nil }
        XCTAssertFalse(forwarded)
        task.cancel()
    }

    func testOfflineModelManagerNeverDiscoversOrSaves() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ModelProviderStore(stateDirectory: directory)
        let controller = try ModelManagerWindow(store: store, offlinePreview: true)
        controller.availableModelNames = "manual"
        controller.refreshAvailableModels()
        controller.testConnection()
        controller.saveSettings()
        XCTAssertFalse(controller.isFetchingModels)
        XCTAssertFalse(controller.isTesting)
        XCTAssertEqual(controller.availableModelNames, "manual")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
    }
}
