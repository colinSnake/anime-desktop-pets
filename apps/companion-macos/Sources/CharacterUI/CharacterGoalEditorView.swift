import CharacterCore
import SwiftUI

struct CharacterGoalEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var details: String
    @State private var steps: String
    @State private var isSuggesting = false
    @State private var suggestionStatus = ""
    @State private var confirmsOnlineShare = false
    @State private var suggestionTask: Task<Void, Never>?
    private let existingGoal: CharacterGoal?
    private let onCreate: ((String, String, String) -> Void)?
    private let onUpdate: ((CharacterGoal) -> Void)?
    private let suggestGoal: ((String, String) async throws -> CharacterGoalDraft)?

    init(onSave: @escaping (String, String, String) -> Void,
         suggestGoal: ((String, String) async throws -> CharacterGoalDraft)? = nil) {
        existingGoal = nil
        onCreate = onSave
        onUpdate = nil
        self.suggestGoal = suggestGoal
        _title = State(initialValue: "")
        _details = State(initialValue: "")
        _steps = State(initialValue: "")
    }

    init(goal: CharacterGoal, suggestGoal: ((String, String) async throws -> CharacterGoalDraft)? = nil,
         onSave: @escaping (CharacterGoal) -> Void) {
        existingGoal = goal
        onCreate = nil
        onUpdate = onSave
        self.suggestGoal = suggestGoal
        _title = State(initialValue: goal.title)
        _details = State(initialValue: goal.details)
        _steps = State(initialValue: goal.steps.map(\.text).joined(separator: "\n"))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(existingGoal == nil ? "新建目标" : "编辑目标").font(.title2.weight(.semibold))
            TextField("目标名称", text: $title)
            TextField("补充说明（可选）", text: $details, axis: .vertical).lineLimit(2...4)
            VStack(alignment: .leading, spacing: 5) {
                Text("计划步骤").font(.headline)
                Text("每行写一步；留空也可以先保存目标。")
                    .font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $steps).frame(minHeight: 150)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.25)))
            }
            if suggestGoal != nil {
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        if isSuggesting {
                            suggestionTask?.cancel()
                        } else {
                            confirmsOnlineShare = true
                        }
                    } label: {
                        Label(isSuggesting ? "停止生成" : "让桌宠拟一个计划草案",
                              systemImage: isSuggesting ? "stop.circle" : "wand.and.stars")
                    }
                    .disabled(!isSuggesting && title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("只会发送目标名称和说明；结果先填入这里，不会自动保存或执行。")
                        .font(.caption).foregroundStyle(.secondary)
                    if !suggestionStatus.isEmpty {
                        Text(suggestionStatus).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Spacer()
                Button("取消", role: .cancel) { suggestionTask?.cancel(); dismiss() }
                Button("保存") { save() }
                    .buttonStyle(CharacterActionButtonStyle())
                    .disabled(isSuggesting || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520, height: 420)
        .confirmationDialog("将目标名称和说明发送给模型服务商？", isPresented: $confirmsOnlineShare,
                            titleVisibility: .visible) {
            Button("发送并生成草案") {
                if let suggestGoal { requestSuggestion(suggestGoal) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("只发送当前目标名称和说明，不发送身份资料或记忆。请求可能产生费用。草案不会自动保存或执行。")
        }
        .onDisappear { suggestionTask?.cancel() }
    }

    private func save() {
        if var goal = existingGoal {
            goal.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
            goal.details = details.trimmingCharacters(in: .whitespacesAndNewlines)
            var remainingSteps = goal.steps
            let lines = steps.components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            goal.steps = lines.map { text in
                if let index = remainingSteps.firstIndex(where: { $0.text == text }) {
                    var step = remainingSteps.remove(at: index)
                    step.text = text
                    return step
                }
                return CharacterGoal.Step(text: text)
            }
            onUpdate?(goal)
        } else {
            onCreate?(title, details, steps)
        }
        dismiss()
    }

    private func requestSuggestion(_ suggest: @escaping (String, String) async throws -> CharacterGoalDraft) {
        let requestedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requestedTitle.isEmpty else { return }
        isSuggesting = true
        suggestionStatus = ""
        suggestionTask = Task {
            do {
                guard let draft = try await suggest(requestedTitle, requestedDetails).normalized() else {
                    throw CharacterGoalSuggestionError.invalidDraft
                }
                guard !Task.isCancelled,
                      title.trimmingCharacters(in: .whitespacesAndNewlines) == requestedTitle,
                      details.trimmingCharacters(in: .whitespacesAndNewlines) == requestedDetails else {
                    suggestionStatus = "目标内容已更改，已丢弃旧草案。"
                    isSuggesting = false
                    return
                }
                title = draft.title
                details = draft.details
                steps = draft.steps.joined(separator: "\n")
                suggestionStatus = "草案已填入，请检查后再保存。"
            } catch {
                suggestionStatus = Task.isCancelled ? "草案已取消。" : "草案生成失败：\(error.localizedDescription)"
            }
            isSuggesting = false
            suggestionTask = nil
        }
    }
}

private enum CharacterGoalSuggestionError: LocalizedError {
    case invalidDraft

    var errorDescription: String? { "模型返回的计划格式无效。" }
}
