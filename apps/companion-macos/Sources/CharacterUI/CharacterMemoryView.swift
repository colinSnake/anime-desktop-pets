import CharacterCore
import SwiftUI

enum CharacterMemoryCollection: String, CaseIterable {
    case personal = "个人记忆"
    case knowledge = "角色知识"

    func contains(_ memory: CharacterMemory) -> Bool {
        (self == .knowledge) == (memory.kind == .knowledge)
    }
}

struct CharacterMemoryView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var collection: CharacterMemoryCollection
    @State private var draftText = ""
    @State private var draftKind = CharacterMemoryKind.preference
    @State private var draftSource = ""
    @State private var draftCitation = ""
    @State private var draftVersion = ""
    @State private var confirmsAutomaticReview = false

    init(model: CharacterWorkspaceModel, collection: CharacterMemoryCollection = .personal) {
        self.model = model
        _collection = State(initialValue: collection)
    }

    private var visibleMemories: [CharacterMemory] { model.memories.filter(collection.contains) }
    private var candidates: [CharacterMemory] { visibleMemories.filter { $0.status == .candidate } }
    private var confirmed: [CharacterMemory] { visibleMemories.filter { $0.status == .confirmed } }
    private var isKnowledge: Bool { collection == .knowledge }

    var body: some View {
        // One page scroll owns the whole flow. A pinned composer plus a separate
        // list viewport used to squeeze the records below the window's bottom.
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                introduction
                if !isKnowledge, model.reviewMemories != nil { automaticReview }
                composer
                records
                if !model.status.isEmpty {
                    Text(model.status)
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("memory-page-status")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // The shell already supplies 24pt: 24 + 10 aligns with its 34pt heading.
            .padding(.horizontal, 10)
            .padding(.top, 2)
            .padding(.bottom, 24)
        }
        .id(collection) // A different collection starts at its own heading, not the previous list's offset.
        .accessibilityIdentifier("memory-page-scroll")
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 12) {
            CharacterMemoryCollectionTabs(selection: collectionBinding)

            Text(isKnowledge
                 ? "保存有依据的角色设定与知识。添加来源，方便日后核对。"
                 : "记住你的偏好、事实与共同经历，让陪伴更了解你。")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var automaticReview: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Text("自动审核普通记忆").font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 12)
                Toggle("自动审核普通记忆", isOn: Binding(
                    get: { model.automaticReviewEnabled },
                    set: { enabled in
                        if enabled { confirmsAutomaticReview = true }
                        else { model.setAutomaticReviewEnabled(false) }
                    }
                ))
                .labelsHidden().toggleStyle(.switch).controlSize(.mini)
            }
            Text("每累计 3 条用户发言，额外发送最多 6 条原话给当前模型审核，可能产生额外费用。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("可靠且低风险的记忆自动保存；敏感、冲突或不确定内容留待确认。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            DisclosureGroup("审核范围与费用") {
                Text("开启后，每累计 3 条用户发言，会额外发送最多 6 条原话给当前模型。助手回复、身份和已有记忆不会发送。请求可能产生费用；在线分享保持关闭，随时可停用。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
            }
            .font(.system(size: 11))
            if !model.automaticReviewStatus.isEmpty {
                Text(model.automaticReviewStatus).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .modifier(CharacterMemoryCard())
        .confirmationDialog("开启 AI 自动审核？", isPresented: $confirmsAutomaticReview, titleVisibility: .visible) {
            Button("开启自动审核") { model.setAutomaticReviewEnabled(true) }
            Button("取消", role: .cancel) {}
        } message: {
            Text("每 3 条用户发言将额外发送最多 6 条原话给当前模型。助手回复、身份和已有记忆不会发送。请求可能产生费用；低风险记忆会自动保存到本机，在线分享保持关闭。")
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(isKnowledge ? "添加角色知识" : "添加个人记忆")
                    .font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 12)
                if !isKnowledge {
                    CharacterMemoryCategoryMenu(selection: $draftKind)
                }
            }
            CharacterMemoryEditor(
                text: $draftText, identifier: "memory-composer",
                placeholder: isKnowledge ? "写下清晰、可核对的角色知识…" : "写下希望角色记住的一件事…"
            )
            if isKnowledge {
                CharacterMemoryTextField(title: "来源（必填）", text: $draftSource, identifier: "memory-source")
                DisclosureGroup("补充引用与版本（可选）") {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 12) { citationField; versionField }
                        VStack(alignment: .leading, spacing: 12) { citationField; versionField }
                    }
                    .padding(.top, 8)
                }
                .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            let effectiveKind: CharacterMemoryKind = isKnowledge ? .knowledge : draftKind
            let draftFindings = model.draftMemoryFindings(text: draftText, kind: effectiveKind)
            if !draftFindings.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("提交前提醒").font(.caption.weight(.semibold))
                    ForEach(Array(draftFindings.enumerated()), id: \.offset) { _, finding in
                        Text("• \(finding.title)：\(finding.message)")
                            .font(.caption).foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { submissionHint; Spacer(minLength: 12); submitButton }
                VStack(alignment: .leading, spacing: 10) {
                    submissionHint
                    HStack { Spacer(); submitButton }
                }
            }
        }
        .modifier(CharacterMemoryCard())
    }

    private var citationField: some View {
        CharacterMemoryTextField(title: "引用或位置", text: $draftCitation, identifier: "memory-citation")
    }

    private var versionField: some View {
        CharacterMemoryTextField(title: "版本或日期", text: $draftVersion, identifier: "memory-version")
    }

    private var submissionHint: some View {
        Text("先加入待确认，不会覆盖已有资料。")
            .font(.system(size: 11)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var submitButton: some View {
        Button("加入待确认") {
            guard model.addMemory(text: draftText, kind: isKnowledge ? .knowledge : draftKind,
                                  source: isKnowledge ? draftSource : "用户在角色与记忆窗口添加",
                                  citation: isKnowledge ? draftCitation : "",
                                  version: isKnowledge ? draftVersion : "") else { return }
            draftText = ""
            if isKnowledge { draftCitation = ""; draftVersion = "" }
        }
        .buttonStyle(ManagementActionButtonStyle(prominent: true, compact: true))
        .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || (isKnowledge && draftSource.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
        .accessibilityIdentifier("memory-submit")
    }

    private var records: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            if visibleMemories.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: isKnowledge ? "books.vertical" : "brain.head.profile")
                        .font(.system(size: 22)).foregroundStyle(.secondary)
                    Text(isKnowledge ? "还没有角色知识" : "还没有个人记忆")
                        .font(.system(size: 13, weight: .medium))
                    Text(isKnowledge ? "从一条有来源的角色设定开始。"
                         : (model.reviewMemories == nil ? "添加一条希望角色记住的事。" : "添加一条希望角色记住的事，或开启 AI 自动审核。"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity)
                .modifier(CharacterMemoryCard())
                .accessibilityIdentifier("memory-empty-state")
            }
            memorySection("待确认", items: candidates)
            memorySection("已确认", items: confirmed)
        }
    }

    private var collectionBinding: Binding<CharacterMemoryCollection> {
        Binding(get: { collection }, set: { value in
            collection = value
            draftKind = value == .knowledge ? .knowledge : .preference
        })
    }

    @ViewBuilder private func memorySection(_ title: String, items: [CharacterMemory]) -> some View {
        if !items.isEmpty {
            HStack(spacing: 8) {
                Text(title).font(.headline)
                Text("\(items.count)").font(.caption).foregroundStyle(.secondary)
            }
            // LazyVStack flattens the two ForEach groups. Namespace IDs by status
            // so a moved record cannot keep the old candidate row alive.
            ForEach(items, id: \.reviewRowIdentity) { memory in
                CharacterMemoryRow(
                    memory: memory,
                    onConfirm: { model.confirm($0) },
                    onUpdate: { model.update($0) },
                    onDelete: { model.delete($0) },
                    onHistory: model.loadMemoryHistory,
                    onRestore: model.restoreMemoryRevision,
                    onFindings: model.memoryFindings
                )
            }
        }
    }
}

private extension CharacterMemory {
    var reviewRowIdentity: String { "\(status.rawValue):\(id)" }
}
