import CharacterCore
import CharacterMemory
import SwiftUI

public struct CharacterWorkspaceView: View {
    private enum Page: String, CaseIterable, Identifiable {
        case identity = "身份"
        case memories = "记忆"
        case capabilities = "能力"
        var id: String { rawValue }
    }

    @StateObject private var model: CharacterWorkspaceModel
    private let capabilities: [CharacterCapability]
    @State private var page = Page.identity

    public init(store: CharacterMemoryStore, defaultName: String,
                capabilities: [CharacterCapability]) {
        _model = StateObject(wrappedValue: CharacterWorkspaceModel(store: store, defaultName: defaultName))
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
                }
            }
        }
        .frame(minWidth: 700, minHeight: 520)
        .onChange(of: page) { selected in
            if selected == .memories { model.refresh() }
        }
    }
}
