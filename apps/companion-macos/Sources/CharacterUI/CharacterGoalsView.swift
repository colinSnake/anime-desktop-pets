import CharacterCore
import SwiftUI

struct CharacterGoalsView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var showingNewGoal = false
    @State private var editingGoal: CharacterGoal?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                CharacterSectionHeader(title: "目标与计划", subtitle: "记录你决定推进的目标和步骤；桌宠不会在后台替你执行。")
                Spacer()
                Button("新建目标") { showingNewGoal = true }
                    .buttonStyle(CharacterActionButtonStyle())
            }
            if model.goals.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "target").font(.system(size: 28)).foregroundStyle(.secondary)
                    Text("还没有目标").font(.headline)
                    Text("创建目标后，可以逐步记录进度。")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(model.goals) { goal in
                            CharacterGoalRow(goal: goal,
                                             onUpdate: model.updateGoal,
                                             onEdit: { editingGoal = goal },
                                             onDelete: { model.deleteGoal(goal) })
                        }
                    }
                }
            }
            Text(model.status).font(.callout).foregroundStyle(.secondary)
        }
        .padding(20)
        .sheet(isPresented: $showingNewGoal) {
            CharacterGoalEditorView(onSave: model.addGoal)
        }
        .sheet(item: $editingGoal) { goal in
            CharacterGoalEditorView(goal: goal) { updated in model.updateGoal(updated) }
        }
    }
}

private struct CharacterGoalRow: View {
    let goal: CharacterGoal
    let onUpdate: (CharacterGoal) -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    @State private var confirmsDeletion = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(goal.title).font(.headline)
                    Text(statusText).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("编辑", action: onEdit)
                Menu {
                    Button(goal.status == .paused ? "继续推进" : "暂停目标") { changeStatus() }
                    Button(goal.status == .completed ? "重新开启" : "标记完成") { changeStatus(toCompleted: true) }
                    Divider()
                    Button("删除目标", role: .destructive) { confirmsDeletion = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .help("目标操作")
            }
            if !goal.details.isEmpty { Text(goal.details).font(.callout).foregroundStyle(.secondary) }
            if !goal.steps.isEmpty {
                ProgressView(value: Double(goal.completedStepCount), total: Double(goal.steps.count))
                ForEach(goal.steps) { step in
                    Toggle(step.text, isOn: Binding(
                        get: { step.isComplete },
                        set: { complete in
                            var changed = goal
                            guard let index = changed.steps.firstIndex(where: { $0.id == step.id }) else { return }
                            changed.steps[index].isComplete = complete
                            onUpdate(changed)
                        }
                    ))
                    .toggleStyle(.checkbox)
                }
                Text("已完成 \(goal.completedStepCount) / \(goal.steps.count) 步")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .confirmationDialog("删除这个目标及其计划？此操作无法撤销。", isPresented: $confirmsDeletion,
                            titleVisibility: .visible) {
            Button("删除目标", role: .destructive, action: onDelete)
            Button("取消", role: .cancel) {}
        }
    }

    private var statusText: String { "\(goal.status.rawValue) · 更新进度会立即保存到本机" }

    private func changeStatus(toCompleted: Bool = false) {
        var changed = goal
        if toCompleted {
            changed.status = goal.status == .completed ? .active : .completed
        } else {
            changed.status = goal.status == .paused ? .active : .paused
        }
        onUpdate(changed)
    }
}
