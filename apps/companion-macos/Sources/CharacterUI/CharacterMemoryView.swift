import CharacterCore
import SwiftUI

struct CharacterMemoryView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var draftText = ""
    @State private var draftKind = CharacterMemoryKind.preference

    private var candidates: [CharacterMemory] { model.memories.filter { $0.status == .candidate } }
    private var confirmed: [CharacterMemory] { model.memories.filter { $0.status == .confirmed } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CharacterSectionHeader(
                title: "本地记忆",
                subtitle: "新内容先待审核；只有确认并单独允许分享的记忆才会发给在线模型。"
            )
            HStack {
                Picker("类型", selection: $draftKind) {
                    ForEach(CharacterMemoryKind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .frame(width: 150)
                TextField("添加一条记忆", text: $draftText)
                Button("提交审核") {
                    model.addMemory(text: draftText, kind: draftKind)
                    draftText = ""
                }
                .buttonStyle(CharacterActionButtonStyle())
                .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    memorySection("待审核", items: candidates)
                    memorySection("已确认", items: confirmed)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text(model.status).font(.callout).foregroundStyle(.secondary)
        }
        .padding(20)
    }

    @ViewBuilder private func memorySection(_ title: String, items: [CharacterMemory]) -> some View {
        if !items.isEmpty {
            Text(title).font(.headline)
            ForEach(items) { memory in
                CharacterMemoryRow(
                    memory: memory,
                    onConfirm: { model.confirm($0) },
                    onUpdate: { model.update($0) },
                    onDelete: { model.delete($0) }
                )
            }
        }
    }
}

private struct CharacterMemoryRow: View {
    let memory: CharacterMemory
    let onConfirm: (CharacterMemory) -> Void
    let onUpdate: (CharacterMemory) -> Void
    let onDelete: (CharacterMemory) -> Void
    @State private var draftText: String
    @State private var shareEnabled: Bool
    @State private var confirmsDeletion = false

    init(memory: CharacterMemory, onConfirm: @escaping (CharacterMemory) -> Void,
         onUpdate: @escaping (CharacterMemory) -> Void, onDelete: @escaping (CharacterMemory) -> Void) {
        self.memory = memory
        self.onConfirm = onConfirm
        self.onUpdate = onUpdate
        self.onDelete = onDelete
        _draftText = State(initialValue: memory.text)
        _shareEnabled = State(initialValue: memory.shareWithOnlineModel)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(memory.kind.rawValue).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Toggle("允许在线模型使用", isOn: $shareEnabled)
                    .toggleStyle(.checkbox)
                    .onChange(of: shareEnabled) { value in update(text: draftText, share: value) }
            }
            TextField("记忆内容", text: $draftText, axis: .vertical).lineLimit(2...5)
            HStack {
                if draftText != memory.text {
                    Button("保存修改") { update(text: draftText, share: shareEnabled) }
                        .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if memory.status == .candidate {
                    Button("确认记忆") {
                        var changed = memory
                        changed.text = draftText
                        changed.shareWithOnlineModel = shareEnabled
                        onConfirm(changed)
                    }
                    .buttonStyle(CharacterActionButtonStyle())
                    .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Button("删除", role: .destructive) { confirmsDeletion = true }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .confirmationDialog("删除这条记忆？此操作无法撤销。", isPresented: $confirmsDeletion, titleVisibility: .visible) {
            Button("删除记忆", role: .destructive) { onDelete(memory) }
            Button("取消", role: .cancel) {}
        }
    }

    private func update(text: String, share: Bool) {
        var changed = memory
        changed.text = text
        changed.shareWithOnlineModel = share
        onUpdate(changed)
    }
}
