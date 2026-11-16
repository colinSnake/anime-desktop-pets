import SwiftUI

struct CharacterIdentityView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var showingCompletion = false
    @State private var showingFoundation = false
    @State private var showingHistory = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 16) {
                Text("身份")
                    .font(.system(size: 24, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("保存身份", action: model.saveIdentity)
                    .buttonStyle(CharacterIdentitySaveButtonStyle())
                    .disabled(!model.canSaveIdentity)
            }
            .padding(.bottom, 18)
            if !model.status.isEmpty {
                Text(model.status)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 12)
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    CharacterIdentityEditor(title: "名称", text: $model.identity.name)
                    CharacterIdentityEditor(title: "性格", text: $model.identity.personality)
                    CharacterIdentityEditor(title: "表达方式", text: $model.identity.speakingStyle)
                    CharacterIdentityEditor(title: "与你的关系", text: $model.identity.relationship)

                    DisclosureGroup("基础设定", isExpanded: $showingFoundation) {
                        VStack(alignment: .leading, spacing: 16) {
                            readOnlyField("身份定位", value: model.identity.resolvedRole)
                            readOnlyField("背景", value: model.identity.resolvedBackground)
                            readOnlyField("核心价值", value: model.identity.values)
                            readOnlyField("愿望与方向", value: model.identity.motivations)
                            readOnlyField("知识范围", value: model.identity.knowledgeScope)
                            readOnlyField("行为边界", value: model.identity.boundaries)
                            if !model.identityCompletionFields.isEmpty {
                                Button("预览并补齐空白设定") { showingCompletion = true }
                                    .disabled(!model.canSaveIdentity)
                            }
                        }
                        .padding(.top, 12)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text("身份资料默认只保存在本机；允许分享后才会进入在线模型请求。")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Toggle("允许在线模型使用这份身份资料", isOn: $model.identity.shareWithOnlineModel)
                    }

                    CharacterAdaptationView(model: model)

                    if model.identity.revision > 1 || !model.identityHistory.isEmpty {
                        DisclosureGroup("身份修订记录（最近10版）", isExpanded: $showingHistory) {
                            if !model.identityHistoryError.isEmpty {
                                Text("读取身份历史失败：\(model.identityHistoryError)")
                                    .font(.caption).foregroundStyle(.red)
                            } else if model.identityHistory.isEmpty {
                                Text("暂无可恢复的身份版本。")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else {
                                ForEach(model.identityHistory.sorted { $0.revision > $1.revision }, id: \.revision) { version in
                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack {
                                            Text("版本 \(version.revision) · \(version.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                                                .font(.caption.weight(.medium))
                                            Spacer()
                                            Button("恢复此版") { model.restoreIdentityRevision(version.revision) }
                                                .buttonStyle(.borderless)
                                        }
                                        identityHistoryField("名称", version.name)
                                        identityHistoryField("性格", version.personality)
                                        identityHistoryField("表达方式", version.speakingStyle)
                                        identityHistoryField("与你的关系", version.relationship)
                                    }
                                    .padding(.vertical, 8)
                                    if version.revision != model.identityHistory.map(\.revision).max() {
                                        Divider()
                                    }
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .sheet(isPresented: $showingCompletion) {
            VStack(alignment: .leading, spacing: 14) {
                Text("补齐空白身份字段").font(.title2)
                Text("仅补下列空白字段，保留名称、已有文字和分享设置；应用到表单后仍需点“保存身份”。")
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.identityCompletionFields) { field in
                            Text(field.title).font(.headline)
                            Text(field.value).textSelection(.enabled)
                        }
                    }
                }
                HStack {
                    Spacer()
                    Button("取消") { showingCompletion = false }
                    Button("补入表单") { model.applyIdentityCompletion(); showingCompletion = false }
                        .disabled(!model.canSaveIdentity || model.identityCompletionFields.isEmpty)
                }
            }.padding(20).frame(width: 580, height: 480)
        }
    }

    private func readOnlyField(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.body.weight(.medium))
            Text(value.isEmpty ? "未设置" : value)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func identityHistoryField(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value.isEmpty ? "未设置" : value)
                .font(.callout).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct CharacterIdentitySaveButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background(CharacterUIStyle.input, in: RoundedRectangle(cornerRadius: 7))
            .overlay {
                RoundedRectangle(cornerRadius: 7)
                    .strokeBorder(colorScheme == .dark ? Color.white.opacity(0.30) : Color.black.opacity(0.22), lineWidth: 1)
            }
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.6)
    }
}
