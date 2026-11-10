import Foundation

public struct CharacterCapability: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable {
        case enabled = "可用"
        case needsSetup = "需要设置"
        case unavailable = "暂不可用"
        case planned = "尚未接入"
        case onDemand = "按需检查"
    }

    public var id: String
    public var name: String
    public var status: Status
    public var detail: String

    public init(id: String, name: String, status: Status, detail: String) {
        self.id = id
        self.name = name
        self.status = status
        self.detail = detail
    }
}
