import CharacterCore
import CharacterMemory
import Foundation
import SwiftUI

@MainActor
public final class CharacterWorkspaceModel: ObservableObject {
    @Published public var identity: CharacterIdentity
    @Published public private(set) var identityHistory: [CharacterIdentity] = []
    @Published public private(set) var identityHistoryError = ""
    @Published public internal(set) var memories: [CharacterMemory] = []
    @Published public private(set) var goals: [CharacterGoal] = []
    @Published public internal(set) var chatTurns: [CharacterChatTurn] = []
    @Published public var chatDraft = ""
    @Published public internal(set) var chatModelCatalog: CharacterChatModelCatalog?
    @Published public internal(set) var selectedChatModel: String?
    @Published public internal(set) var chatModelError = ""
    @Published public internal(set) var isChatSending = false
    @Published public internal(set) var failedChatText: String?
    @Published public internal(set) var chatStatus = ""
    @Published public private(set) var status = ""
    @Published public internal(set) var automaticReviewEnabled = false
    @Published public internal(set) var automaticReviewStatus = ""

    @Published public internal(set) var adaptation = CharacterAdaptationState()
    @Published public internal(set) var adaptationStatus = ""
    var adaptationTask: Task<Void, Never>?
    var adaptationGeneration: UUID?

    var chatTask: Task<Void, Never>?
    var automaticReviewTask: Task<Void, Never>?
    var automaticReviewSettingsTask: Task<Void, Never>?
    var automaticReviewSettingsGeneration: UUID?
    var automaticReviewGeneration = UUID()
    var unreviewedTurnIDs: [UUID] = []
    var activeChatAttempt: CharacterChatAttempt?
    var failedChatAttempt: CharacterChatAttempt?
    @Published public private(set) var canSaveIdentity = false

    let store: CharacterMemoryStore
    private let defaultName: String
    public let suggestGoal: ((String, String) async throws -> CharacterGoalDraft)?
    public let chat: ((String, [CharacterChatTurn], CharacterChatModelSelection?) async throws -> String)?
    public let reviewMemories: (([CharacterChatTurn], CharacterChatModelSelection?) async throws -> [CharacterMemorySuggestion])?

    let chatModels: (() throws -> CharacterChatModelCatalog?)?

    let fetchChatModels: ((String) async throws -> CharacterChatModelCatalog)?
    @Published public internal(set) var isDiscoveringChatModels = false
    @Published public internal(set) var chatModelNotice = ""

    public init(store: CharacterMemoryStore, defaultName: String,
                suggestGoal: ((String, String) async throws -> CharacterGoalDraft)? = nil,
                chat: ((String, [CharacterChatTurn], CharacterChatModelSelection?) async throws -> String)? = nil,
                reviewMemories: (([CharacterChatTurn], CharacterChatModelSelection?) async throws -> [CharacterMemorySuggestion])? = nil,
                chatModels: (() throws -> CharacterChatModelCatalog?)? = nil,
                discoverChatModels: ((String) async throws -> CharacterChatModelCatalog)? = nil) {
        self.store = store
        self.defaultName = defaultName
        self.suggestGoal = suggestGoal
        self.chat = chat
        self.reviewMemories = reviewMemories
        self.chatModels = chatModels
        self.fetchChatModels = discoverChatModels
        identity = .starter(name: defaultName)
        refresh()
    }

    deinit {
        chatTask?.cancel()
        automaticReviewTask?.cancel()
    }

    public func refresh() {
        Task {
            do {
                identity = try await store.loadIdentity(defaultName: defaultName)
                identityHistory = try await store.identityHistory()
                identityHistoryError = ""
                memories = try await store.listMemories()
                let savedAdaptation = try await store.loadAdaptation()
                if adaptationGeneration == nil { adaptation = savedAdaptation }
                if let warning = store.adaptationSessionWarning { adaptationStatus = warning }
                let savedReviewEnabled = try await store.loadAutomaticReviewEnabled()
                // Refresh is not a new consent action. Never restore a stale
                // on-disk authorization over this window's explicit choice.
                if automaticReviewSettingsGeneration == nil {
                    automaticReviewEnabled = savedReviewEnabled
                    if !savedReviewEnabled { discardPendingAutomaticReview() }
                }
                canSaveIdentity = true
                status = ""
            } catch {
                canSaveIdentity = false
                status = error.localizedDescription
                identityHistoryError = error.localizedDescription
            }
        }
    }

    public func refreshMemories() {
        Task {
            do {
                memories = try await store.listMemories()
                status = ""
            } catch { status = error.localizedDescription }
        }
    }

    public func loadMemoryHistory(id: String) async throws -> [CharacterMemory] {
        try await store.memoryHistory(id: id)
    }

    public func restoreMemoryRevision(id: String, revision: Int) {
        Task {
            do {
                try await store.restoreMemoryRevision(id: id, revision: revision)
                memories = try await store.listMemories()
                status = "已恢复为新待确认版本；请重新核对并授权在线分享。"
            } catch { status = error.localizedDescription }
        }
    }

    public func refreshGoals() {
        Task {
            do {
                goals = try await store.listGoals()
                status = ""
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func addGoal(title: String, details: String, stepLines: String) {
        let steps = stepLines.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { CharacterGoal.Step(text: $0) }
        let goal = CharacterGoal(title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                 details: details.trimmingCharacters(in: .whitespacesAndNewlines), steps: steps)
        Task {
            do {
                try await store.saveGoal(goal)
                goals = try await store.listGoals()
                status = "目标已保存在本机。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func updateGoal(_ goal: CharacterGoal) {
        Task {
            do {
                try await store.saveGoal(goal)
                goals = try await store.listGoals()
                status = "计划进度已保存。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func deleteGoal(_ goal: CharacterGoal) {
        Task {
            do {
                try await store.deleteGoal(id: goal.id)
                goals = try await store.listGoals()
                status = "目标已删除。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public var identityCompletionFields: [CharacterIdentityCompletion.Field] {
        CharacterIdentityCompletion.proposedFields(for: identity, defaultName: defaultName)
    }

    public func applyIdentityCompletion() {
        guard canSaveIdentity else { return }
        identity = CharacterIdentityCompletion.fillingBlanks(in: identity, defaultName: defaultName)
        status = "已补齐空白字段，原有内容和分享设置保留。请检查后保存身份。"
    }

    public func saveIdentity() {
        guard canSaveIdentity else { return }
        guard let name = identity.validatedName else {
            status = "名称不能为空，最多80个字符，且不能包含换行。"
            return
        }
        var snapshot = identity
        snapshot.name = name
        Task {
            do {
                try await store.saveIdentity(snapshot)
                identityHistory = try await store.identityHistory()
                status = "身份资料已保存。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func restoreIdentityRevision(_ revision: Int) {
        Task {
            do {
                try await store.restoreIdentityRevision(revision: revision)
                identity = try await store.loadIdentity(defaultName: defaultName)
                identityHistory = try await store.identityHistory()
                identityHistoryError = ""
                status = "已恢复身份版本；在线分享已关闭，请检查后重新授权。"
            } catch {
                identityHistoryError = error.localizedDescription
                status = error.localizedDescription
            }
        }
    }

    @discardableResult
    public func addMemory(text: String, kind: CharacterMemoryKind, source: String = "用户在角色与记忆窗口添加",
                          citation: String = "", version: String = "") -> Bool {
        let item = CharacterMemory(kind: kind, text: text, source: source, citation: citation, version: version)
        guard !CharacterMemoryReview.isCredentialLike(CharacterMemoryReview.memoryContent(item)) else {
            status = CharacterMemoryStoreError.credentialLikeRecord.localizedDescription
            return false
        }
        Task {
            do {
                try await store.saveMemory(item)
                memories = try await store.listMemories()
                let findings = CharacterMemoryReview.findings(for: item, against: memories)
                status = findings.isEmpty
                    ? "记忆已加入审核列表，确认后才会正式保存。"
                    : "记忆已加入审核列表，但发现：" + findings.map(\.title).joined(separator: "、") + "。请先核对。"
            } catch {
                status = error.localizedDescription
            }
        }
        return true
    }

    public func memoryFindings(for memory: CharacterMemory) -> [CharacterMemoryReview.Finding] {
        CharacterMemoryReview.findings(for: memory, against: memories)
    }

    public func draftMemoryFindings(text: String, kind: CharacterMemoryKind) -> [CharacterMemoryReview.Finding] {
        let candidate = CharacterMemory(kind: kind, text: text, source: "用户在角色与记忆窗口添加")
        return CharacterMemoryReview.findings(for: candidate, against: memories)
    }

    public func confirm(_ memory: CharacterMemory) {
        Task {
            do {
                try await store.confirmMemory(memory)
                memories = try await store.listMemories()
                status = memories.first(where: { $0.id == memory.id })?.status == .confirmed
                    ? "记忆已确认。" : "知识内容或依据已变化，已转回待审核并关闭分享；请重新核对后确认。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func update(_ memory: CharacterMemory) {
        Task {
            do {
                try await store.saveMemory(memory)
                memories = try await store.listMemories()
                let saved = memories.first { $0.id == memory.id }
                status = memory.kind == .knowledge && saved?.status == .candidate && memory.status == .confirmed
                    ? "知识内容或依据已变化，已转回待审核并关闭分享。"
                    : "修改已保存。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func delete(_ memory: CharacterMemory) {
        Task {
            do {
                try await store.deleteMemory(id: memory.id)
                memories = try await store.listMemories()
                status = "记忆已删除。"
            } catch {
                status = error.localizedDescription
            }
        }
    }
}
