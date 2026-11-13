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
            HStack(alignment: .top, spacing: 12) {
                CharacterSectionHeader(
                    title: "本地记忆",
                    subtitle: "新内容先进入待审核；在线分享需逐条允许。"
                )
                Spacer(minLength: 8)
                Button("导入知识…") { showingImport = true }
            }
            VStack(alignment: .leading, spacing: 12) {
                Picker("类型", selection: $draftKind) {
                    ForEach(CharacterMemoryKind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .frame(maxWidth: 220, alignment: .leading)
                TextEditor(text: $draftText)
                    .font(.body)
                    .frame(minHeight: 76, maxHeight: 112)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(CharacterUIStyle.input, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(CharacterUIStyle.border, lineWidth: 0.5))
                    .overlay(alignment: .topLeading) {
                        if draftText.isEmpty {
                            Text(draftKind == .knowledge ? "写下一条可核对的角色知识…" : "写下一条简洁、明确的记忆…")
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 14)
                                .allowsHitTesting(false)
                        }
                    }
            if draftKind == .knowledge {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("知识来源（作者、作品或用户设定）", text: $draftSource)
                        HStack(spacing: 8) {
                            TextField("引用或定位（可选）", text: $draftCitation)
                            TextField("版本或日期（可选）", text: $draftVersion)
                        }
                    }
                    .textFieldStyle(.roundedBorder)
                    Text("来源信息用于核对依据，不会被当作模型指令。")
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
                HStack {
                    Text("待审核后才会用于回答")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("加入待审核") {
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
            }
            .padding(14)
            .background {
                RoundedRectangle(cornerRadius: 10)
                    .fill(CharacterUIStyle.cardBackground)
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(CharacterUIStyle.border.opacity(0.45), lineWidth: 0.5)
                    }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if candidates.isEmpty && confirmed.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "brain.head.profile")
                                .font(.system(size: 24))
                                .foregroundStyle(.secondary)
                            Text("还没有记忆").font(.headline)
                            Text("添加记忆或导入知识后，会先在这里审核。")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 160)
                        .background(CharacterUIStyle.cardBackground, in: RoundedRectangle(cornerRadius: 10))
                    }
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
        .background {
            RoundedRectangle(cornerRadius: 10)
                .fill(CharacterUIStyle.cardBackground)
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(CharacterUIStyle.border.opacity(0.45), lineWidth: 0.5)
                }
        }
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
