import CharacterCore
import CharacterMemory
import SwiftUI

public enum CharacterWorkspacePage: String, CaseIterable, Identifiable {
    case chat = "聊天"
    case identity = "身份"
    case memories = "记忆"
    case capabilities = "能力"
    case goals = "目标"
    public var id: String { rawValue }
}

@MainActor
public final class CharacterWorkspaceNavigation: ObservableObject {
    @Published public var page: CharacterWorkspacePage

    public init(page: CharacterWorkspacePage = .identity) {
        self.page = page
    }
}

@MainActor
public struct CharacterWorkspaceView: View {
    @StateObject private var model: CharacterWorkspaceModel
    @ObservedObject private var navigation: CharacterWorkspaceNavigation
    private let capabilities: [CharacterCapability]

    public init(store: CharacterMemoryStore, defaultName: String,
                capabilities: [CharacterCapability],
                suggestGoal: ((String, String) async throws -> CharacterGoalDraft)? = nil,
                chat: ((String, [CharacterChatTurn]) async throws -> String)? = nil,
                navigation: CharacterWorkspaceNavigation? = nil) {
        _model = StateObject(wrappedValue: CharacterWorkspaceModel(store: store, defaultName: defaultName,
                                                                   suggestGoal: suggestGoal, chat: chat))
        _navigation = ObservedObject(wrappedValue: navigation ?? CharacterWorkspaceNavigation())
        self.capabilities = capabilities
    }

    public var body: some View {
        Group {
            switch navigation.page {
            case .chat: CharacterChatView(model: model)
            case .identity: CharacterIdentityView(model: model)
            case .memories: CharacterMemoryView(model: model)
            case .capabilities: CharacterCapabilitiesView(capabilities: capabilities)
            case .goals: CharacterGoalsView(model: model)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CharacterUIStyle.canvas)
        .onChange(of: navigation.page) { selected in
            switch selected {
            case .memories: model.refreshMemories()
            case .goals: model.refreshGoals()
            default: break
            }
        }
    }
}
