import CharacterCore
import SwiftUI

struct CharacterMemoryRow: View {
    let memory: CharacterMemory
    let onConfirm: (CharacterMemory) -> Void
    let onUpdate: (CharacterMemory) -> Void
    let onDelete: (CharacterMemory) -> Void
    let onHistory: (String) async throws -> [CharacterMemory]
    let onRestore: (String, Int) -> Void
    let onFindings: (CharacterMemory) -> [CharacterMemoryReview.Finding]
    @State private var draftText: String
    @State private var draftSource: String
    @State private var hasExpiry: Bool
    @State private var expiresAt: Date
    @State private var draftCitation: String
    @State private var draftVersion: String
    @State private var shareEnabled: Bool
    @State private var confirmsDeletion = false
    @State private var history: [CharacterMemory] = []
    @State private var historyExpanded = false
    @State private var historyLoaded = false
    @State private var isLoadingHistory = false
    @State private var historyError: String?

    init(memory: CharacterMemory, onConfirm: @escaping (CharacterMemory) -> Void,
         onUpdate: @escaping (CharacterMemory) -> Void, onDelete: @escaping (CharacterMemory) -> Void,
         onHistory: @escaping (String) async throws -> [CharacterMemory],
         onRestore: @escaping (String, Int) -> Void,
         onFindings: @escaping (CharacterMemory) -> [CharacterMemoryReview.Finding]) {
        self.memory = memory
        _draftSource = State(initialValue: memory.source)
        _hasExpiry = State(initialValue: memory.expiresAt != nil)
        _expiresAt = State(initialValue: memory.expiresAt ?? .now.addingTimeInterval(30 * 86400))
        self.onConfirm = onConfirm
        self.onUpdate = onUpdate
        self.onDelete = onDelete
        self.onHistory = onHistory
        self.onRestore = onRestore
        self.onFindings = onFindings
        _draftText = State(initialValue: memory.text)
        _draftCitation = State(initialValue: memory.citation)
        _draftVersion = State(initialValue: memory.version)
        _shareEnabled = State(initialValue: memory.shareWithOnlineModel)
    }

    private var hasChanges: Bool {
        draftText != memory.text || draftSource != memory.source || draftCitation != memory.citation
            || draftVersion != memory.version || (hasExpiry ? expiresAt : nil) != memory.expiresAt
            || shareEnabled != memory.shareWithOnlineModel
    }

    private var hasContentChanges: Bool {
        draftText != memory.text || draftSource != memory.source || draftCitation != memory.citation
            || draftVersion != memory.version || (hasExpiry ? expiresAt : nil) != memory.expiresAt
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Text(memory.kind.rawValue).font(.caption.weight(.medium))
                Text(memory.status == .candidate ? "待确认" : "已确认")
                    .font(.caption).foregroundStyle(memory.status == .candidate ? .orange : .secondary)
                Spacer(minLength: 6)
                Toggle("允许在线模型使用", isOn: $shareEnabled)
                    .toggleStyle(.checkbox)
            }

            Text("版本 \(memory.revision) · 创建于 \(memory.createdAt.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            CharacterMemoryEditor(text: $draftText, identifier: "memory-entry-\(memory.id)",
                                  placeholder: "编辑这条资料的内容…")

            if memory.kind == .knowledge {
                VStack(alignment: .leading, spacing: 8) {
                    CharacterMemoryTextField(title: "来源", text: $draftSource,
                                             identifier: "memory-entry-source-\(memory.id)")
                    HStack(spacing: 10) {
                        CharacterMemoryTextField(title: "引用或位置", text: $draftCitation,
                                                 identifier: "memory-entry-citation-\(memory.id)")
                        CharacterMemoryTextField(title: "版本或日期", text: $draftVersion,
                                                 identifier: "memory-entry-version-\(memory.id)")
                    }
                    Toggle("设置知识有效期", isOn: $hasExpiry).toggleStyle(.checkbox)
                    if hasExpiry {
                        DatePicker("有效至", selection: $expiresAt, displayedComponents: [.date, .hourAndMinute])
                            .controlSize(.regular)
                    }
                    if memory.isExpired() {
                        Text("已过期，不会用于回答。更新依据或有效期后需重新确认。")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
            }

            let findings = onFindings(memory)
            if !findings.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(findings.enumerated()), id: \.offset) { _, finding in
                        Text("• \(finding.title)：\(finding.message)")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Text("请自行决定保留、修改或删除；系统不会自动合并。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            if hasChanges {
                VStack(alignment: .leading, spacing: 5) {
                    Text("修订预览").font(.caption.weight(.semibold))
                    if draftText != memory.text {
                        revisionLine("内容", before: memory.text, after: draftText)
                    }
                    if memory.kind == .knowledge {
                        if draftSource != memory.source {
                            revisionLine("来源", before: memory.source, after: draftSource)
                        }
                        if draftCitation != memory.citation {
                            revisionLine("引用/位置", before: memory.citation, after: draftCitation)
                        }
                        if draftVersion != memory.version {
                            revisionLine("版本/日期", before: memory.version, after: draftVersion)
                        }
                        let proposedExpiry = hasExpiry ? expiresAt.formatted(date: .abbreviated, time: .shortened) : "无有效期"
                        let currentExpiry = memory.expiresAt?.formatted(date: .abbreviated, time: .shortened) ?? "无有效期"
                        if proposedExpiry != currentExpiry {
                            revisionLine("有效期", before: currentExpiry, after: proposedExpiry)
                        }
                    }
                    if shareEnabled != memory.shareWithOnlineModel {
                        revisionLine("在线授权", before: memory.shareWithOnlineModel ? "开启" : "关闭",
                                     after: shareEnabled ? "开启" : "关闭")
                    }
                    Text(hasContentChanges
                         ? "保存内容修订后转为待确认并关闭在线分享；原版本可恢复。"
                         : "仅修改授权不会改变内容版本。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(CharacterUIStyle.cardBackground, in: RoundedRectangle(cornerRadius: 6))
            }

            if memory.revision > 1 || !history.isEmpty {
                DisclosureGroup("修订记录（最近10版）", isExpanded: $historyExpanded) {
                    if isLoadingHistory {
                        ProgressView().controlSize(.small)
                    } else if let historyError {
                        HStack {
                            Text("读取修订记录失败：\(historyError)")
                                .font(.caption).foregroundStyle(.red)
                            Button("重试") { loadHistory() }.buttonStyle(.borderless)
                        }
                    } else if history.isEmpty {
                        Text("暂无可恢复版本。删除资料会一并清除版本历史。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(history.sorted { $0.revision > $1.revision }) { version in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text("版本 \(version.revision) · \(version.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption.weight(.medium))
                                    Spacer()
                                    Button("恢复此版") { onRestore(memory.id, version.revision) }
                                        .buttonStyle(.borderless)
                                }
                                Text(version.text).font(.callout).textSelection(.enabled)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
                .font(.callout)
                .onChange(of: historyExpanded) { expanded in
                    guard expanded, !historyLoaded else { return }
                    loadHistory()
                }
            }

            HStack(spacing: 8) {
                if memory.status == .candidate {
                    Button("确认此条") {
                        let changed = editedMemory
                        onConfirm(changed)
                    }
                    .buttonStyle(ManagementActionButtonStyle(prominent: true, compact: true))
                    .frame(height: ManagementControlStyle.compactHeight)
                    .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasChanges)
                    if hasChanges {
                        Text("先保存修改，再确认。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if hasChanges {
                    Button(hasContentChanges ? "提交修订待确认" : "保存授权") { onUpdate(editedMemory) }
                        .buttonStyle(ManagementActionButtonStyle(prominent: true, compact: true))
                        .frame(height: ManagementControlStyle.compactHeight)
                        .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Button("删除", role: .destructive) { confirmsDeletion = true }
                    .buttonStyle(ManagementActionButtonStyle(compact: true))
                    .frame(height: ManagementControlStyle.compactHeight)
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
            history = []
            historyLoaded = false
            historyError = nil
        }
        .modifier(CharacterMemoryCard())
        .confirmationDialog("删除这条资料？此操作无法撤销。", isPresented: $confirmsDeletion, titleVisibility: .visible) {
            Button("删除资料", role: .destructive) { onDelete(memory) }
            Button("取消", role: .cancel) {}
        }
    }

    private var editedMemory: CharacterMemory {
        var changed = memory
        changed.text = draftText
        changed.source = draftSource
        changed.expiresAt = hasExpiry ? expiresAt : nil
        changed.citation = draftCitation
        changed.version = draftVersion
        changed.shareWithOnlineModel = shareEnabled
        return changed
    }

    private func revisionLine(_ label: String, before: String, after: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.medium))
            Text("当前：\(before.isEmpty ? "（空）" : before)")
                .font(.caption).foregroundStyle(.secondary)
            Text("拟修订：\(after.isEmpty ? "（空）" : after)")
                .font(.caption)
        }
    }

    private func loadHistory() {
        guard !isLoadingHistory else { return }
        isLoadingHistory = true
        historyError = nil
        Task {
            defer { isLoadingHistory = false }
            do {
                history = try await onHistory(memory.id)
                historyLoaded = true
            } catch {
                history = []
                historyError = error.localizedDescription
                historyLoaded = false
            }
        }
    }
}
