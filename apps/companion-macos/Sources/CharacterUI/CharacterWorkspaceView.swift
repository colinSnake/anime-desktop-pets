import CharacterCore
import CharacterMemory
import SwiftUI

public struct CharacterWorkspaceView: View {
    private enum Page: String, CaseIterable, Identifiable {
        case identity = "身份"
        case memories = "记忆"
        case capabilities = "能力"
        case goals = "目标"
        var id: String { rawValue }
    }

    @StateObject private var model: CharacterWorkspaceModel
    private let capabilities: [CharacterCapability]
    @State private var page = Page.identity

    public init(store: CharacterMemoryStore, defaultName: String,
                capabilities: [CharacterCapability],
                suggestGoal: ((String, String) async throws -> CharacterGoalDraft)? = nil) {
        _model = StateObject(wrappedValue: CharacterWorkspaceModel(store: store, defaultName: defaultName,
                                                                   suggestGoal: suggestGoal))
        self.capabilities = capabilities
    }

    public var body: some View {
        VStack(spacing: 0) {
            Picker("区域", selection: $page) {
                ForEach(Page.allCases) { page in Text(page.rawValue).tag(page) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 20)
            .padding(.top, 16)
            Group {
                switch page {
                case .identity: CharacterIdentityView(model: model)
                case .memories: CharacterMemoryView(model: model)
                case .capabilities: CharacterCapabilitiesView(capabilities: capabilities)
                case .goals: CharacterGoalsView(model: model)
                }
            }
        }
        .frame(minWidth: 700, minHeight: 520)
        .onChange(of: page) { selected in
            switch selected {
            case .memories: model.refresh()
            case .goals: model.refreshGoals()
            default: break
            }
        }
    }
}
