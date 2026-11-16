import SwiftUI

struct CharacterChatModelPicker: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var isPresented = false

    var body: some View {
        Button {
            model.refreshChatModels()
            isPresented = true
        } label: {
            HStack(spacing: 5) {
                Text(model.chatModelCatalog.map { "\($0.providerName) · \(model.selectedChatModel ?? "选择模型")" } ?? "选择模型")
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 200, alignment: .trailing)
                Image(systemName: "chevron.down").font(.caption2)
            }
            .font(.callout)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.primary)
        .disabled(model.isChatSending)
        .help("选择本轮文字聊天使用的模型；不更改全局默认模型")
        .accessibilityLabel("选择模型，当前\(model.selectedChatModel ?? "未配置")")
        .accessibilityIdentifier("chat-model-picker")
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            CharacterChatModelList(model: model) { isPresented = false }
        }
        .onChange(of: model.isChatSending) { sending in
            if sending { isPresented = false }
        }
    }
}

/// The system popover supplies its own rounded chrome, shadow and dismissal behavior.
struct CharacterChatModelList: View {
    @ObservedObject var model: CharacterWorkspaceModel
    var dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("选择模型").font(.headline)
            if let catalog = model.chatModelCatalog, !catalog.models.isEmpty {
                Text(catalog.providerName).font(.caption).foregroundStyle(.secondary)
                List(catalog.models, id: \.self) { name in
                    Button {
                        model.selectChatModel(name)
                        dismiss()
                    } label: {
                        HStack(spacing: 8) {
                            Text(name).lineLimit(2).truncationMode(.middle)
                            Spacer(minLength: 8)
                            if model.selectedChatModel == name {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isChatSending)
                    .accessibilityAddTraits(model.selectedChatModel == name ? .isSelected : [])
                    .accessibilityLabel(name + (model.selectedChatModel == name ? "，当前选择" : ""))
                }
                .listStyle(.inset)
                .frame(height: CGFloat(min(catalog.models.count, 6)) * 44)
                Text("仅影响后续文字聊天。打开列表不会联网；可在模型管理中手工填写模型 ID。")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(model.chatModelError.isEmpty ? "尚未保存模型配置。请到侧栏“模型管理”填写默认模型及可选模型。" : model.chatModelError)
                    .font(.callout).foregroundStyle(.secondary)
                Text("本机身份、记忆和目标问答仍可使用。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if model.canDiscoverChatModels {
                Button(action: model.discoverChatModels) {
                    HStack(spacing: 8) {
                        if model.isDiscoveringChatModels { ProgressView().controlSize(.small) }
                        Label("刷新服务端模型列表", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(model.isChatSending || model.isDiscoveringChatModels)
                .accessibilityIdentifier("chat-model-discover")
            }
            if !model.chatModelNotice.isEmpty {
                Text(model.chatModelNotice).font(.caption).foregroundStyle(.secondary)
            }
            if model.chatModelCatalog != nil, !model.chatModelError.isEmpty {
                Text(model.chatModelError).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 300, alignment: .leading)
        .tint(CharacterBrandStyle.cursor)
        .accessibilityIdentifier("chat-model-popover")
    }
}
