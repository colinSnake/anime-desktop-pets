import CharacterCore
import Foundation

extension ModelProviderSettings {
    func mergingDiscoveredModels(_ models: [String]) throws -> Self {
        var next = self
        var seen = Set([model])
        next.availableModels = Array((availableModels + models).filter { seen.insert($0).inserted }.prefix(32))
        try next.validate()
        return next
    }
}

/// Persist only when the exact settings used for discovery are still current.
@MainActor
struct ModelCatalogRefresher {
    var load: () throws -> ModelProviderSettings
    var save: (ModelProviderSettings) throws -> Void
    var readKey: () throws -> String?
    var discover: (ModelProviderSettings, String) async throws -> [String]

    init(load: @escaping () throws -> ModelProviderSettings,
         save: @escaping (ModelProviderSettings) throws -> Void,
         readKey: @escaping () throws -> String?,
         discover: @escaping (ModelProviderSettings, String) async throws -> [String]) {
        self.load = load
        self.save = save
        self.readKey = readKey
        self.discover = discover
    }

    init(store: ModelProviderStore) {
        self.init(load: { try store.load() }, save: { try store.save($0) },
                  readKey: { try ModelAPIKeyStore().read() },
                  discover: { try await ModelDiscoveryClient().fetchModels(settings: $0, apiKey: $1) })
    }

    func refresh(expectedServiceID: String) async throws -> CharacterChatModelCatalog {
        let original = try load()
        try original.validate()
        guard original.chatCatalog.serviceID == expectedServiceID else { throw settingsChanged }
        guard let key = try readKey()?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else {
            throw ModelProviderError.missingAPIKey
        }
        let models = try await discover(original, key)
        try Task.checkCancellation()
        guard try load() == original else { throw settingsChanged }
        let next = try original.mergingDiscoveredModels(models)
        try save(next)
        return next.chatCatalog
    }

    private var settingsChanged: ModelProviderError {
        .service("模型设置已更改，请重新打开模型列表后刷新。")
    }
}
