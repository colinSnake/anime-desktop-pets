import CharacterCore
import SwiftUI

struct CharacterMemoryView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var showingImport = false
    @State private var draftText = ""
    @State private var draftKind = CharacterMemoryKind.preference
    @State private var draftSource = "用户在角色与记忆窗口添加"
    @State private var draftCitation = ""
    @State private var draftVersion = ""

    private var candidates: [CharacterMemory] { model.memories.filter { $0.status == .candidate } }
    private var confirmed: [CharacterMemory] { model.memories.filter { $0.status == .confirmed } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CharacterSectionHeader(
                title: "本地记忆",
                subtitle: "手动添加的记忆先审核；语音明确要求记住普通内容时可自动保存到本机。在线分享仍需逐条允许。"
            )
            Button("导入角色知识…") { showingImport = true }
            HStack {
                Picker("类型", selection: $draftKind) {
                    ForEach(CharacterMemoryKind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .frame(width: 150)
                TextField(draftKind == .knowledge ? "添加一条角色知识" : "添加一条记忆", text: $draftText)
                Button("保存记忆") {
                    if model.addMemory(text: draftText, kind: draftKind, source: draftSource,
                                       citation: draftCitation, version: draftVersion) {
                        draftText = ""
                        draftCitation = ""
                        draftVersion = ""
                    }
                }
                .buttonStyle(CharacterActionButtonStyle())
                .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if draftKind == .knowledge {
                HStack {
                    TextField("知识来源（作者、作品或用户设定）", text: $draftSource)
                    TextField("引用或定位（可选）", text: $draftCitation)
                    TextField("版本/日期（可选）", text: $draftVersion)
                }
                .font(.caption)
                Text("角色知识会在在线上下文中带上来源、引用和版本；这些字段只是依据，不是模型指令。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            let draftFindings = model.draftMemoryFindings(text: draftText, kind: draftKind)
            if !draftFindings.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("提交前提醒").font(.caption.weight(.semibold))
                    ForEach(Array(draftFindings.enumerated()), id: \.offset) { _, finding in
                        Text("• \(finding.title)：\(finding.message)")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Text("仍会进入待审核区，不会自动覆盖旧记忆。")
                        .font(.caption).foregroundStyle(.secondary)
                }
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
        .sheet(isPresented: $showingImport) { CharacterKnowledgeImportView(model: model) }
    }

    @ViewBuilder private func memorySection(_ title: String, items: [CharacterMemory]) -> some View {
        if !items.isEmpty {
            Text(title).font(.headline)
            ForEach(items) { memory in
                CharacterMemoryRow(
                    memory: memory,
                    onConfirm: { model.confirm($0) },
                    onUpdate: { model.update($0) },
                    onDelete: { model.delete($0) },
                    onFindings: model.memoryFindings
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
    let onFindings: (CharacterMemory) -> [CharacterMemoryReview.Finding]
    @State private var draftText: String
    @State private var draftSource: String
    @State private var hasExpiry: Bool
    @State private var expiresAt: Date
    @State private var draftCitation: String
    @State private var draftVersion: String
    @State private var shareEnabled: Bool
    @State private var confirmsDeletion = false

    init(memory: CharacterMemory, onConfirm: @escaping (CharacterMemory) -> Void,
         onUpdate: @escaping (CharacterMemory) -> Void, onDelete: @escaping (CharacterMemory) -> Void,
         onFindings: @escaping (CharacterMemory) -> [CharacterMemoryReview.Finding]) {
        self.memory = memory
        _draftSource = State(initialValue: memory.source)
        _hasExpiry = State(initialValue: memory.expiresAt != nil)
        _expiresAt = State(initialValue: memory.expiresAt ?? .now.addingTimeInterval(30 * 86400))
        self.onConfirm = onConfirm
        self.onUpdate = onUpdate
        self.onDelete = onDelete
        self.onFindings = onFindings
        _draftText = State(initialValue: memory.text)
        _draftCitation = State(initialValue: memory.citation)
        _draftVersion = State(initialValue: memory.version)
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
            if memory.kind == .knowledge {
                TextField("来源", text: $draftSource).font(.caption)
                Toggle("设置有效期", isOn: $hasExpiry).toggleStyle(.checkbox)
                if hasExpiry { DatePicker("有效至", selection: $expiresAt, displayedComponents: [.date, .hourAndMinute]) }
                if memory.isExpired() { Text("已过期：不会参与本机或在线回答，请更新依据和有效期后重新确认。").foregroundStyle(.orange) }
                HStack {
                    TextField("引用或定位", text: $draftCitation)
                    TextField("版本/日期", text: $draftVersion)
                }
                .font(.caption)
            }
            let findings = onFindings(memory)
            if !findings.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(findings.enumerated()), id: \.offset) { _, finding in
                        Text("• \(finding.title)：\(finding.message)")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Text("请由你决定保留、修改或删除，不会自动合并。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack {
                if draftText != memory.text || draftCitation != memory.citation || draftVersion != memory.version || draftSource != memory.source
                    || (hasExpiry ? expiresAt : nil) != memory.expiresAt {
                    Button("保存修改") { update(text: draftText, share: shareEnabled) }
                        .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if memory.status == .candidate {
                    Button("确认记忆") {
                        var changed = memory
                        changed.text = draftText
                        changed.source = draftSource
                        changed.expiresAt = hasExpiry ? expiresAt : nil
                        changed.citation = draftCitation
                        changed.version = draftVersion
                        changed.shareWithOnlineModel = shareEnabled
                        onConfirm(changed)
                    }
                    .buttonStyle(CharacterActionButtonStyle())
                    .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Button("删除", role: .destructive) { confirmsDeletion = true }
            }
        }
        .onChange(of: memory) { value in
            draftText = value.text
            draftSource = value.source
            draftCitation = value.citation
            draftVersion = value.version
            hasExpiry = value.expiresAt != nil
            if let date = value.expiresAt { expiresAt = date }
            shareEnabled = value.shareWithOnlineModel
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
        changed.source = draftSource
        changed.expiresAt = hasExpiry ? expiresAt : nil
        changed.citation = draftCitation
        changed.version = draftVersion
        changed.shareWithOnlineModel = share
        onUpdate(changed)
    }
}
