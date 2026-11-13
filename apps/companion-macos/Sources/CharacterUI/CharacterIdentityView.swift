import SwiftUI

struct CharacterIdentityView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @State private var showingCompletion = false

    var body: some View {
        Form {
            Section {
                Text("身份资料默认只保存在本机；允许分享后才会进入在线模型请求。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if !model.identityCompletionFields.isEmpty {
                    Button("预览龙妹默认设定并补齐空白") { showingCompletion = true }
                        .disabled(!model.canSaveIdentity)
                }
                TextField("名称", text: $model.identity.name)
                identityField("身份定位", hint: "它是谁、在这里扮演什么角色", text: $model.identity.role, height: 64)
                identityField("背景", hint: "重要经历与设定", text: $model.identity.background, height: 88)
            } header: {
                Text("基本资料")
            }
            Section("性格与表达") {
                identityField("性格", hint: "稳定的性格特点和相处方式", text: $model.identity.personality)
                identityField("表达方式", hint: "语气、节奏和偏好的表达风格", text: $model.identity.speakingStyle)
            }
            Section("价值与关系") {
                identityField("核心价值", hint: "遇到选择时优先坚持什么", text: $model.identity.values)
                identityField("愿望与方向", hint: "希望持续做好什么", text: $model.identity.motivations)
                identityField("与用户的关系", hint: "如何理解彼此", text: $model.identity.relationship)
            }
            Section("知识与边界") {
                identityField("知识范围", hint: "知道什么、不确定什么", text: $model.identity.knowledgeScope)
                identityField("行为边界", hint: "不能假装知道或执行的事", text: $model.identity.boundaries)
            }
            Section("隐私") {
                Toggle("允许在线模型使用这份身份资料", isOn: $model.identity.shareWithOnlineModel)
            }
            Section {
                HStack(spacing: 12) {
                    Button("保存身份", action: model.saveIdentity)
                        .disabled(!model.canSaveIdentity)
                    Text(model.status).font(.callout).foregroundStyle(.secondary)
                }
            }
        }
        .listRowBackground(CharacterUIStyle.cardBackground)
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
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

    private func identityField(_ title: String, hint: String, text: Binding<String>, height: CGFloat = 72) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.body.weight(.medium))
            Text(hint).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: text)
                .font(.body)
                .frame(minHeight: height, maxHeight: height)
                .scrollContentBackground(.hidden)
                .padding(5)
                .background(CharacterUIStyle.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(CharacterUIStyle.border, lineWidth: 0.5))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
