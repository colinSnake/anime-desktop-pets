import Foundation

/// Shared gate for future character actions. It decides whether an action may
/// proceed; it does not execute the action or grant access to any capability.
public struct CharacterAction: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case readCharacterData
        case writeLocalMemory
        case createLocalGoal
        case updateLocalGoal
        case deleteLocalData
        case changeIdentity
        case sendOnlineRequest
        case publishExternalContent
        case accessCredential
        case makePayment
        case changePermission
        case unknown
    }

    public let kind: Kind
    public let explicitlyRequested: Bool
    public let reversible: Bool

    public init(kind: Kind, explicitlyRequested: Bool = false, reversible: Bool = false) {
        self.kind = kind
        self.explicitlyRequested = explicitlyRequested
        self.reversible = reversible
    }
}

public enum CharacterActionDecision: Equatable, Sendable {
    case allowAutomatically(String)
    case requireUserApproval(String)
    case deny(String)
}

public enum CharacterActionPolicy {
    public static func decision(for action: CharacterAction) -> CharacterActionDecision {
        switch action.kind {
        case .readCharacterData:
            return .allowAutomatically("只读取角色资料目录，不访问其它用户文件。")

        case .writeLocalMemory, .createLocalGoal, .updateLocalGoal:
            guard action.explicitlyRequested else {
                return .requireUserApproval("必须由用户明确提出，不能从普通对话推断。")
            }
            guard action.reversible else {
                return .requireUserApproval("不可逆的本地变更需要人工确认。")
            }
            return .allowAutomatically("用户已明确提出，且变更仅限本机、可撤销。")

        case .sendOnlineRequest:
            guard action.explicitlyRequested else {
                return .requireUserApproval("联网请求必须由用户明确发起。")
            }
            return .allowAutomatically("用户已明确发起本轮请求；资料分享仍受独立授权控制。")

        case .deleteLocalData, .changeIdentity:
            return .requireUserApproval("删除、覆盖或修改角色核心身份必须人工确认。")

        case .publishExternalContent, .accessCredential, .makePayment, .changePermission:
            return .requireUserApproval("涉及对外发布、安全、支付或权限变化，必须人工确认。")

        case .unknown:
            return .requireUserApproval("未知动作不得自动执行。")
        }
    }
}
