import CharacterCore
import Foundation

@MainActor
extension CharacterWorkspaceModel {
    public var canDiscoverChatModels: Bool { fetchChatModels != nil && chatModelCatalog != nil }

    /// Read saved settings only. Opening a view or a popover never discovers models.
    public func refreshChatModels() {
        guard !isChatSending else { return }
        do {
            applyChatCatalog(try chatModels?())
            chatModelError = ""
        } catch {
            applyChatCatalog(nil)
            chatModelError = "无法读取模型列表，请在模型管理中检查配置。"
        }
    }

    public func selectChatModel(_ name: String) {
        guard !isChatSending, chatModelCatalog?.models.contains(name) == true else { return }
        selectedChatModel = name
    }

    public func discoverChatModels() {
        guard !isChatSending, !isDiscoveringChatModels,
              let fetchChatModels, let catalog = chatModelCatalog else { return }
        isDiscoveringChatModels = true
        chatModelError = ""
        chatModelNotice = "正在获取模型列表…"
        Task { [weak self] in
            do {
                let next = try await fetchChatModels(catalog.serviceID)
                guard let self else { return }
                let current = try self.chatModels?()
                guard next.serviceID == catalog.serviceID, current?.serviceID == catalog.serviceID else {
                    self.applyChatCatalog(current)
                    throw ChatCatalogError.changed
                }
                self.applyChatCatalog(next)
                self.chatModelNotice = "已刷新并保留手工模型；可选列表最多 32 个，可在模型管理中编辑。"
            } catch {
                self?.chatModelError = error.localizedDescription + " 可继续使用已保存的模型列表或手工配置。"
                self?.chatModelNotice = ""
            }
            self?.isDiscoveringChatModels = false
        }
    }

    private func applyChatCatalog(_ next: CharacterChatModelCatalog?) {
        if next?.serviceID != chatModelCatalog?.serviceID ||
            !((next?.models ?? []).contains(selectedChatModel ?? "")) {
            selectedChatModel = next.flatMap { $0.models.contains($0.defaultModel) ? $0.defaultModel : $0.models.first }
        }
        chatModelCatalog = next
    }
}

private enum ChatCatalogError: LocalizedError {
    case changed
    var errorDescription: String? { "模型服务已更改，请重新打开列表后刷新。" }
}
