import Foundation

public enum CharacterActionKind: String, Sendable {
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

public enum CharacterActionDecision: Equatable, Sendable {
    case allowAutomatically(String)
    case requireUserApproval(String)
    case deny(String)
}

public enum CharacterActionPolicy {
    public static func decision(for context: CharacterActionRequestContext) -> CharacterActionDecision {
        switch context.kind {
        case .readCharacterData:
            return .allowAutomatically("只读取角色资料目录，不访问其它用户文件。")

        case .writeLocalMemory, .createLocalGoal, .updateLocalGoal:
            guard context.source == .userInitiated else {
                return .requireUserApproval("必须由用户明确提出，不能从普通对话推断。")
            }
            guard context.reversibility == .confirmed else {
                return .requireUserApproval("变更的撤销能力未确认，需要人工审核。")
            }
            return .allowAutomatically("用户已明确提出，且变更仅限本机、可撤销。")

        case .sendOnlineRequest:
            guard context.source == .userInitiated else {
                return .requireUserApproval("联网请求必须由用户明确发起。")
            }
            return .allowAutomatically("用户已明确发起本轮请求；身份和记忆分享仍分别受授权控制。")

        case .deleteLocalData, .changeIdentity:
            return context.approvalGranted
                ? .allowAutomatically("用户已对本次明确操作作出确认。")
                : .requireUserApproval("删除、覆盖或修改角色核心身份必须人工确认。")

        case .publishExternalContent, .makePayment, .changePermission:
            return context.approvalGranted
                ? .allowAutomatically("用户已对本次明确操作作出确认。")
                : .requireUserApproval("涉及对外发布、支付或权限变化，必须人工确认。")

        case .accessCredential:
            return .deny("桌边小崽不读取或暴露密码、API Key、Token 等凭证。")

        case .unknown:
            return .requireUserApproval("未知动作不得自动执行。")
        }
    }
}

/// An immutable host-issued capability. Its initializer and all provenance
/// fields are file-private so model data cannot manufacture trusted context.
public struct CharacterActionRequestContext: Equatable, Sendable {
    public enum Source: String, Sendable {
        case userInitiated
        case modelSuggested
        case system
    }

    public enum Reversibility: String, Sendable {
        case confirmed
        case unknown
    }

    fileprivate let operationID: UUID
    fileprivate let source: Source
    fileprivate let approvalTokenReference: UUID
    fileprivate let expiresAtUptime: TimeInterval
    fileprivate let replayNonce: UUID
    fileprivate let kind: CharacterActionKind
    fileprivate let reversibility: Reversibility
    fileprivate let approvalGranted: Bool

    fileprivate init(operationID: UUID, source: Source, approvalTokenReference: UUID,
                     expiresAtUptime: TimeInterval, replayNonce: UUID, kind: CharacterActionKind,
                     reversibility: Reversibility, approvalGranted: Bool) {
        self.operationID = operationID
        self.source = source
        self.approvalTokenReference = approvalTokenReference
        self.expiresAtUptime = expiresAtUptime
        self.replayNonce = replayNonce
        self.kind = kind
        self.reversibility = reversibility
        self.approvalGranted = approvalGranted
    }
}

/// Main-thread issuer for UI-originated actions. Issued contexts are registered
/// in memory, expire quickly, and can be consumed exactly once.
@MainActor
public final class CharacterActionContextIssuer {
    private struct Registration: Equatable {
        let context: CharacterActionRequestContext
    }

    private var registrations: [UUID: Registration] = [:]
    private let lifetime: TimeInterval
    private let uptime: @MainActor () -> TimeInterval

    public init(lifetime: TimeInterval = 30) {
        self.lifetime = min(max(lifetime, 1), 120)
        uptime = { ProcessInfo.processInfo.systemUptime }
    }

    internal init(lifetime: TimeInterval, uptime: @escaping @MainActor () -> TimeInterval) {
        self.lifetime = min(max(lifetime, 1), 120)
        self.uptime = uptime
    }

    /// Call only from a concrete user event handler, never with model-provided
    /// provenance. Model suggestions can be registered separately as untrusted.
    public func issueFromUserEvent(kind: CharacterActionKind,
                                   reversibility: CharacterActionRequestContext.Reversibility = .unknown) -> CharacterActionRequestContext {
        issue(kind: kind, source: .userInitiated, reversibility: reversibility,
              approvalGranted: false)
    }

    public func issueAfterUserApproval(for pendingContext: CharacterActionRequestContext) -> CharacterActionRequestContext? {
        let now = uptime()
        guard let registration = registrations[pendingContext.approvalTokenReference],
              registration.context == pendingContext,
              pendingContext.expiresAtUptime > now,
              Self.requiresExplicitApproval(pendingContext.kind),
              case .requireUserApproval = CharacterActionPolicy.decision(for: pendingContext) else {
            return nil
        }

        registrations.removeValue(forKey: pendingContext.approvalTokenReference)
        return issue(kind: pendingContext.kind, source: .userInitiated,
                     reversibility: pendingContext.reversibility,
                     approvalGranted: true, operationID: pendingContext.operationID)
    }

    public func issueModelSuggestion(kind: CharacterActionKind) -> CharacterActionRequestContext {
        issue(kind: kind, source: .modelSuggested, reversibility: .unknown,
              approvalGranted: false)
    }

    /// This is the final local preflight. A token is consumed only if policy
    /// allows the action; every denial, stale context, or replay fails closed.
    public func authorizeForExecution(_ context: CharacterActionRequestContext) -> CharacterActionDecision {
        let now = uptime()
        guard let registration = registrations[context.approvalTokenReference],
              registration.context == context,
              context.expiresAtUptime > now else {
            return .deny("操作凭证无效、已过期或已使用，请重新发起。")
        }

        let decision = CharacterActionPolicy.decision(for: context)
        guard case .allowAutomatically = decision else { return decision }
        registrations.removeValue(forKey: context.approvalTokenReference)
        return decision
    }

    private func issue(kind: CharacterActionKind,
                       source: CharacterActionRequestContext.Source,
                       reversibility: CharacterActionRequestContext.Reversibility,
                       approvalGranted: Bool,
                       operationID: UUID = UUID()) -> CharacterActionRequestContext {
        let now = uptime()
        registrations = registrations.filter { $0.value.context.expiresAtUptime > now }
        let token = UUID()
        let context = CharacterActionRequestContext(
            operationID: operationID, source: source, approvalTokenReference: token,
            expiresAtUptime: now + lifetime, replayNonce: UUID(), kind: kind,
            reversibility: reversibility, approvalGranted: approvalGranted
        )
        registrations[token] = Registration(context: context)
        return context
    }

    private static func requiresExplicitApproval(_ kind: CharacterActionKind) -> Bool {
        switch kind {
        case .deleteLocalData, .changeIdentity, .publishExternalContent, .makePayment, .changePermission:
            return true
        case .readCharacterData, .writeLocalMemory, .createLocalGoal, .updateLocalGoal,
             .sendOnlineRequest, .accessCredential, .unknown:
            return false
        }
    }
}
