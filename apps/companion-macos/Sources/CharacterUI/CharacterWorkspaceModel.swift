import CharacterCore
import CharacterMemory
import Foundation
import SwiftUI

@MainActor
public final class CharacterWorkspaceModel: ObservableObject {
    @Published public var identity: CharacterIdentity
    @Published public private(set) var memories: [CharacterMemory] = []
    @Published public private(set) var goals: [CharacterGoal] = []
    @Published public private(set) var chatTurns: [CharacterChatTurn] = []
    @Published public private(set) var isChatSending = false
    @Published public private(set) var failedChatText: String?
    @Published public private(set) var status = ""
    @Published public private(set) var canSaveIdentity = false

    private let store: CharacterMemoryStore
    private let defaultName: String
    public let suggestGoal: ((String, String) async throws -> CharacterGoalDraft)?
    public let chat: ((String, [CharacterChatTurn]) async throws -> String)?

    public init(store: CharacterMemoryStore, defaultName: String,
                suggestGoal: ((String, String) async throws -> CharacterGoalDraft)? = nil,
                chat: ((String, [CharacterChatTurn]) async throws -> String)? = nil) {
        self.store = store
        self.defaultName = defaultName
        self.suggestGoal = suggestGoal
        self.chat = chat
        identity = .starter(name: defaultName)
        refresh()
    }

    public func refresh() {
        Task {
            do {
                identity = try await store.loadIdentity(defaultName: defaultName)
                memories = try await store.listMemories()
                canSaveIdentity = true
                status = ""
            } catch {
                canSaveIdentity = false
                status = error.localizedDescription
            }
        }
    }


    public func sendChat(_ rawText: String) {
        guard let chat, !isChatSending else { return }
        guard let text = CharacterChatSession.validatedInput(rawText) else {
            if rawText.trimmingCharacters(in: .whitespacesAndNewlines).count > CharacterChatSession.maxTextCharacters {
                status = "单条消息最多 \(CharacterChatSession.maxTextCharacters) 个字符，请缩短后重试。"
            }
            return
        }
        let history = chatTurns
        failedChatText = nil
        appendChatTurn(role: .user, text: text)
        isChatSending = true
        status = "正在整理角色资料并回复…"
        Task {
            do {
                let reply = try await chat(text, history)
                let cleanReply = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleanReply.isEmpty {
                    appendChatTurn(role: .assistant, text: cleanReply)
                }
                status = ""
            } catch {
                failedChatText = text
                status = error.localizedDescription
            }
            isChatSending = false
        }
    }

    public func retryFailedChat() {
        guard let text = failedChatText, !isChatSending else { return }
        if chatTurns.last?.role == .user, chatTurns.last?.text == text {
            chatTurns.removeLast()
        }
        sendChat(text)
    }

    private func appendChatTurn(role: CharacterChatRole, text: String) {
        var session = CharacterChatSession(turns: chatTurns)
        session.append(role: role, text: text)
        chatTurns = session.turns
    }

    public func clearChat() {
        chatTurns.removeAll()
        failedChatText = nil
        status = "本轮聊天已清空；聊天内容不会写入长期记忆。"
    }

    public func refreshMemories() {
        Task {
            do {
                memories = try await store.listMemories()
                status = ""
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
        let snapshot = identity
        Task {
            do {
                try await store.saveIdentity(snapshot)
                status = "身份资料已保存。"
            } catch {
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

    public func loadKnowledgeImportText(from url: URL) async throws -> String {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        return try await store.loadKnowledgeImportText(from: url)
    }

    public func importKnowledge(text: String, source: String, citation: String, version: String,
                                expiresAt: Date?) async -> Bool {
        do {
            let result = try await store.importKnowledge(text: text, source: source, citation: citation,
                                                         version: version, expiresAt: expiresAt)
            memories = try await store.listMemories()
            status = "已导入 \(result.imported) 条待审核知识，跳过 \(result.skipped) 条相同知识；在线分享关闭。"
            return true
        } catch {
            status = error.localizedDescription
            return false
        }
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
