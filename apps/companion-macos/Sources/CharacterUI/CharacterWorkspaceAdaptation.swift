import CharacterCore
import CharacterMemory
import Foundation

@MainActor
extension CharacterWorkspaceModel {
    public func setAdaptationEnabled(_ enabled: Bool) {
        adaptation.enabled = enabled
        enqueueAdaptation(.enabled(enabled))
    }

    public func setAdaptationSharing(_ enabled: Bool) {
        adaptation.shareWithOnlineModel = enabled
        enqueueAdaptation(.sharing(enabled))
    }

    public func rollbackAdaptation() { enqueueAdaptation(.rollback) }
    public func resetAdaptation() { enqueueAdaptation(.reset) }

    private func enqueueAdaptation(_ operation: CharacterAdaptationOperation) {
        let epoch = store.beginAdaptationOperation(operation)
        let previous = adaptationTask
        let generation = UUID()
        adaptationGeneration = generation
        adaptationStatus = "正在保存本地适应设置…"
        // Keep revocations alive even if the window is closed immediately.
        adaptationTask = Task { [self] in
            await previous?.value
            do {
                let saved = try await store.applyAdaptationOperation(operation, epoch: epoch)
                guard adaptationGeneration == generation else { return }
                adaptation = saved
                adaptationStatus = store.adaptationSessionWarning ?? "已保存；只调整表达偏好，不改核心身份。"
            } catch {
                guard adaptationGeneration == generation else { return }
                adaptation.enabled = false
                adaptation.shareWithOnlineModel = false
                adaptationStatus = store.adaptationSessionWarning ?? "设置未保存：\(error.localizedDescription)"
            }
            if adaptationGeneration == generation { adaptationTask = nil }
        }
    }

    func observeAdaptation(_ turn: CharacterChatTurn, epoch: UUID) async {
        await adaptationTask?.value
        let generation = adaptationGeneration
        do {
            let saved = try await store.observeAdaptation(turn, epoch: epoch)
            guard generation == adaptationGeneration else { return }
            adaptation = saved
            if let warning = store.adaptationSessionWarning { adaptationStatus = warning }
        } catch { adaptationStatus = "本次表达适应未保存：\(error.localizedDescription)" }
    }
}
