import CharacterCore
import SwiftUI

struct CharacterGoalEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var details: String
    @State private var steps: String
    private let existingGoal: CharacterGoal?
    private let onCreate: ((String, String, String) -> Void)?
    private let onUpdate: ((CharacterGoal) -> Void)?

    init(onSave: @escaping (String, String, String) -> Void) {
        existingGoal = nil
        onCreate = onSave
        onUpdate = nil
        _title = State(initialValue: "")
        _details = State(initialValue: "")
        _steps = State(initialValue: "")
    }

    init(goal: CharacterGoal, onSave: @escaping (CharacterGoal) -> Void) {
        existingGoal = goal
        onCreate = nil
        onUpdate = onSave
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
            HStack {
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                Button("保存") { save() }
                    .buttonStyle(CharacterActionButtonStyle())
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520, height: 420)
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
}
