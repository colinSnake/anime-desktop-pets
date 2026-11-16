import CharacterCore
import Foundation

/// The workspace owns ephemeral review scheduling; ordinary chat stays independent.
@MainActor
extension CharacterWorkspaceModel {
    public func setAutomaticReviewEnabled(_ enabled: Bool) {
        // Consent is fail-closed: revoke immediately, grant only after durable save.
        let settingsGeneration = UUID()
        automaticReviewSettingsGeneration = settingsGeneration
        automaticReviewEnabled = false
        discardPendingAutomaticReview()
        automaticReviewStatus = enabled
            ? "正在保存自动审核授权；保存成功前不会发送审核请求。"
            : "自动审核已关闭，正在保存设置…"

        // Serialize writes as well as guarding UI callbacks. An older save that
        // is already running must finish before the latest intent is persisted.
        let previousSave = automaticReviewSettingsTask
        // A local consent write must finish even if the workspace closes before
        // this task starts. Unlike model requests, do not weakly discard it.
        automaticReviewSettingsTask = Task { [self] in
            await previousSave?.value
            guard self.automaticReviewSettingsGeneration == settingsGeneration else { return }
            defer {
                if self.automaticReviewSettingsGeneration == settingsGeneration {
                    self.automaticReviewSettingsTask = nil
                }
            }
            do {
                try await self.store.saveAutomaticReviewEnabled(enabled)
                guard self.automaticReviewSettingsGeneration == settingsGeneration else { return }
                self.automaticReviewEnabled = enabled
                if enabled {
                    self.automaticReviewStatus = "开启后，每 3 条用户发言会触发一次额外模型审核；只发送用户原话，可能产生费用。"
                    self.scheduleAutomaticReviewIfReady()
                } else {
                    self.automaticReviewStatus = "自动审核已关闭。"
                }
            } catch {
                guard self.automaticReviewSettingsGeneration == settingsGeneration else { return }
                self.automaticReviewEnabled = false
                self.automaticReviewStatus = enabled
                    ? "自动审核未开启：授权未保存。\(error.localizedDescription)"
                    : "本窗口自动审核已关闭，但关闭设置未保存；重新打开窗口可能仍使用旧授权，请修复后重试关闭。\(error.localizedDescription)"
            }
        }
    }

    /// Clear/disable invalidates in-flight work before asynchronous callbacks resume.
    func discardPendingAutomaticReview() {
        automaticReviewGeneration = UUID()
        automaticReviewTask?.cancel()
        automaticReviewTask = nil
        unreviewedTurnIDs.removeAll()
    }

    func completedUserTurn(_ turn: CharacterChatTurn) {
        guard automaticReviewEnabled, turn.role == .user else { return }
        let retainedIDs = Set(chatTurns.filter { $0.role == .user }.map(\.id))
        unreviewedTurnIDs.removeAll { !retainedIDs.contains($0) }
        if !unreviewedTurnIDs.contains(turn.id) { unreviewedTurnIDs.append(turn.id) }
        unreviewedTurnIDs = Array(unreviewedTurnIDs.suffix(6))
        scheduleAutomaticReviewIfReady()
    }

    private func scheduleAutomaticReviewIfReady() {
        guard automaticReviewEnabled, automaticReviewTask == nil, unreviewedTurnIDs.count >= 3,
              let reviewMemories else { return }
        let batchIDs = Array(unreviewedTurnIDs.prefix(6))
        let batch = chatTurns.filter { batchIDs.contains($0.id) && $0.role == .user }
        let selection = chatModelCatalog.flatMap { catalog in
            selectedChatModel.map { CharacterChatModelSelection(model: $0, serviceID: catalog.serviceID) }
        }
        automaticReviewStatus = "正在后台审核最近的用户发言…"
        let generation = automaticReviewGeneration
        automaticReviewTask = Task { [weak self] in
            do {
                let suggestions = try await reviewMemories(batch, selection)
                try Task.checkCancellation()
                guard let self, self.automaticReviewEnabled, self.automaticReviewGeneration == generation else { return }
                var added = 0
                var queued = 0
                for suggestion in suggestions {
                    try Task.checkCancellation()
                    guard self.automaticReviewEnabled, self.automaticReviewGeneration == generation else { return }
                    switch try await self.store.applyAutomaticReview(suggestion) {
                    case .autoConfirm: added += 1
                    case .requiresReview: queued += 1
                    case .alreadyExists, .doNotStore: break
                    }
                }
                let refreshed = try await self.store.listMemories()
                try Task.checkCancellation()
                guard self.automaticReviewEnabled, self.automaticReviewGeneration == generation else { return }
                self.memories = refreshed
                self.unreviewedTurnIDs.removeAll { batchIDs.contains($0) }
                self.automaticReviewStatus = "自动保存 \(added) 条，转人工核对 \(queued) 条。"
            } catch is CancellationError {
                guard let self, self.automaticReviewGeneration == generation else { return }
                self.automaticReviewTask = nil
                self.automaticReviewStatus = "自动审核已取消；后续发言时会重试。"
                return
            } catch {
                guard let self, self.automaticReviewEnabled, self.automaticReviewGeneration == generation else { return }
                self.automaticReviewStatus = "自动审核未完成；后续发言时会重试。"
                self.automaticReviewTask = nil
                return
            }
            guard let self, self.automaticReviewGeneration == generation else { return }
            self.automaticReviewTask = nil
            self.scheduleAutomaticReviewIfReady()
        }
    }
}
