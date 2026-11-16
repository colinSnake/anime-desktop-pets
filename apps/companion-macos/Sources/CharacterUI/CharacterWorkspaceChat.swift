import CharacterCore
import Foundation

/// Capture the original history once so retries never repeat the user message.
struct CharacterChatAttempt {
    let id = UUID()
    let userTurn: CharacterChatTurn
    let history: [CharacterChatTurn]
    let adaptationEpoch: UUID
}

@MainActor
extension CharacterWorkspaceModel {
    public func sendDraft() {
        guard !isChatSending, chat != nil else { return }
        if let failedChatText,
           chatDraft.trimmingCharacters(in: .whitespacesAndNewlines) == failedChatText {
            retryFailedChat()
            return
        }
        let text = chatDraft
        if CharacterChatSession.validatedInput(text) != nil { chatDraft = "" }
        sendChat(text)
    }

    public func sendChat(_ rawText: String) {
        guard chat != nil, !isChatSending else { return }
        guard let text = CharacterChatSession.validatedInput(rawText) else {
            if rawText.trimmingCharacters(in: .whitespacesAndNewlines).count > CharacterChatSession.maxTextCharacters {
                chatStatus = "单条消息最多 \(CharacterChatSession.maxTextCharacters) 个字符，请缩短后重试。"
            }
            return
        }
        let attempt = CharacterChatAttempt(userTurn: .init(role: .user, text: text),
                                           history: CharacterChatSession.requestHistory(from: chatTurns),
                                           adaptationEpoch: store.adaptationEpoch)
        appendChatTurn(attempt.userTurn)
        startChat(attempt)
    }

    private func startChat(_ attempt: CharacterChatAttempt) {
        guard let chat else { return }
        let selection = chatModelCatalog.flatMap { catalog in
            selectedChatModel.map { CharacterChatModelSelection(model: $0, serviceID: catalog.serviceID) }
        }
        failedChatText = nil
        failedChatAttempt = nil
        activeChatAttempt = attempt
        isChatSending = true
        chatStatus = "正在整理资料并等待回复…"
        chatTask = Task { [weak self] in
            do {
                await self?.adaptationTask?.value
                try Task.checkCancellation()
                let reply = try await chat(attempt.userTurn.text, attempt.history, selection)
                try Task.checkCancellation()
                guard let self, self.activeChatAttempt?.id == attempt.id else { return }
                let clean = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !clean.isEmpty else { throw ChatReplyError.empty }
                self.appendChatTurn(.init(role: .assistant, text: clean))
                await self.observeAdaptation(attempt.userTurn, epoch: attempt.adaptationEpoch)
                self.completedUserTurn(attempt.userTurn)
                self.chatStatus = ""
            } catch {
                guard let self, self.activeChatAttempt?.id == attempt.id else { return }
                self.failedChatAttempt = attempt
                self.failedChatText = attempt.userTurn.text
                self.restoreFailedChatDraft()
                self.chatStatus = error is CancellationError || (error as? URLError)?.code == .cancelled
                    ? "已停止等待回复。"
                    : error.localizedDescription
            }
            guard let self, self.activeChatAttempt?.id == attempt.id else { return }
            self.activeChatAttempt = nil
            self.chatTask = nil
            self.isChatSending = false
        }
    }

    public func cancelChat() {
        guard let attempt = activeChatAttempt, isChatSending else { return }
        // Invalidate first: a service can finish after cancellation or ignore it.
        activeChatAttempt = nil
        chatTask?.cancel()
        chatTask = nil
        isChatSending = false
        failedChatAttempt = attempt
        failedChatText = attempt.userTurn.text
        restoreFailedChatDraft()
        chatStatus = "已停止等待回复；已发出的请求可能仍由服务商处理。"
    }

    public func retryFailedChat() {
        guard let attempt = failedChatAttempt, !isChatSending else { return }
        if chatDraft.trimmingCharacters(in: .whitespacesAndNewlines) == attempt.userTurn.text { chatDraft = "" }
        // Reuse the turn and history; only the selected model may change.
        startChat(CharacterChatAttempt(userTurn: attempt.userTurn, history: attempt.history,
                                       adaptationEpoch: attempt.adaptationEpoch))
    }

    public func restoreFailedChatDraft() {
        guard let failedChatText, chatDraft.isEmpty else { return }
        chatDraft = failedChatText
    }

    private func appendChatTurn(_ turn: CharacterChatTurn) {
        var session = CharacterChatSession(turns: chatTurns)
        session.append(turn)
        chatTurns = session.turns
    }

    public func clearChat() {
        guard !isChatSending else { return }
        discardPendingAutomaticReview()
        chatTurns.removeAll()
        failedChatText = nil
        failedChatAttempt = nil
        chatStatus = "本轮聊天已清空；长期记忆和目标保持不变。"
    }
}

private enum ChatReplyError: LocalizedError {
    case empty
    var errorDescription: String? { "没有收到有效回复，可以重试。" }
}
