import CharacterCore
import Foundation

public enum CharacterAdaptationOperation: Sendable {
    case enabled(Bool), sharing(Bool), rollback, reset
}

extension CharacterMemoryStore {
    /// A caller that queued a UI operation passes its synchronously prepared epoch.
    /// Other callers get the same revocation/invalidation semantics automatically.
    public func applyAdaptationOperation(_ operation: CharacterAdaptationOperation,
                                         epoch: UUID? = nil) throws -> CharacterAdaptationState {
        let session = adaptationSession
        return try session.withLock {
            let token = epoch ?? session.begin(operation)
            do {
                var state = session.applyingDenials(to: try readAdaptationRecord())
                // Separate actors can apply queued choices out of order. A stale
                // grant OR revoke must not overwrite a newer choice for that field.
                switch operation {
                case .enabled where session.learningChange != token: return session.snapshot(state)
                case .sharing where session.sharingChange != token: return session.snapshot(state)
                default: break
                }
                switch operation {
                case .enabled(let value):
                    state.enabled = value
                case .sharing(let value):
                    state.shareWithOnlineModel = value
                case .rollback: _ = state.rollback()
                case .reset: state.reset()
                }
                try writeAdaptationRecord(state)
                // Unrelated setting changes do not invalidate a successful explicit
                // grant, but a newer revoke of this same permission always wins.
                session.completed(operation, token: token)
                return session.snapshot(state)
            } catch {
                session.failedSave(error)
                throw error
            }
        }
    }
}
