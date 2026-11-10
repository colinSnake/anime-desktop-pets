import CharacterCore
import Foundation

/// The online boundary is injected so local routing can be verified without
/// reading credentials or creating a network session.
@MainActor
struct CharacterChatProvider {
    var credentials: (Runtime) throws -> (ModelProviderSettings, String)
    var complete: (ModelProviderSettings, String, String, String?, [CharacterChatTurn]) async throws -> String

    static let live = CharacterChatProvider(
        credentials: { runtime in
            let settings = try ModelProviderStore(stateDirectory: runtime.state).load()
            guard let key = try ModelAPIKeyStore().read()?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !key.isEmpty else { throw ModelProviderError.missingAPIKey }
            return (settings, key)
        },
        complete: { settings, key, text, context, history in
            try await ModelProviderClient().complete(settings: settings, apiKey: key, userText: text,
                                                     characterContext: context, history: history)
        }
    )
}
