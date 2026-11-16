import SwiftUI

struct CharacterAdaptationView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var showingEvidence = false
    @State private var showingControls = false

    var body: some View {
        DisclosureGroup("自动适应 · 可撤销", isExpanded: $showingControls) {
            VStack(alignment: .leading, spacing: 12) {
                Text("核心身份由你掌握。只从你明确提出的表达要求，自动调整详略、活泼程度和建议主动性；不会改写名字、背景、价值观或安全边界。")
                    .font(.callout).foregroundStyle(.secondary)
                Toggle("从明确反馈中自动适应（仅本机，不额外请求 AI）", isOn: Binding(
                    get: { model.adaptation.enabled }, set: model.setAdaptationEnabled))
                Toggle("允许在线聊天使用适应后的表达偏好", isOn: Binding(
                    get: { model.adaptation.shareWithOnlineModel }, set: model.setAdaptationSharing))
                Text("只分享三项表达偏好，不发送反馈原话；独立于核心身份与记忆的分享设置。关闭自动适应后也停止注入。")
                    .font(.caption).foregroundStyle(.secondary)
                Text(model.adaptation.summary).font(.callout).textSelection(.enabled)
                HStack {
                    Button("撤销最近调整", action: model.rollbackAdaptation)
                        .disabled(model.adaptation.history.isEmpty)
                    Button("重置表达偏好", action: model.resetAdaptation)
                }.controlSize(.small)
                if !model.adaptationStatus.isEmpty {
                    Text(model.adaptationStatus).font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup("调整依据与历史（保留最近30条）", isExpanded: $showingEvidence) {
                    ForEach(model.adaptation.history.reversed()) { revision in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("修订 \(revision.revision) · \(revision.reason)").font(.caption.weight(.medium))
                            if let evidence = revision.evidence { Text(evidence.text).font(.caption).textSelection(.enabled) }
                        }.padding(.vertical, 4)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(CharacterUIStyle.input, in: RoundedRectangle(cornerRadius: 10))
    }
}
