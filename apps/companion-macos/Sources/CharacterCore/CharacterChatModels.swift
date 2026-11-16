import Foundation

/// Public, credential-free metadata supplied by the host. Reading it never starts discovery.
public struct CharacterChatModelCatalog: Equatable, Sendable {
    public let serviceID: String
    public let providerName: String
    public let models: [String]
    public let defaultModel: String

    public init(serviceID: String, providerName: String, models: [String], defaultModel: String) {
        self.serviceID = serviceID
        self.providerName = providerName
        self.models = models
        self.defaultModel = defaultModel
    }
}

/// A chat-local choice, scoped to its service so a settings change cannot silently reroute it.
public struct CharacterChatModelSelection: Equatable, Sendable {
    public let model: String
    public let serviceID: String

    public init(model: String, serviceID: String) {
        self.model = model
        self.serviceID = serviceID
    }
}
