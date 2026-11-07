import SwiftUI

struct CharacterIdentityView: View {
    @ObservedObject var model: CharacterWorkspaceModel

    var body: some View {
        Form {
            CharacterSectionHeader(
                title: "角色身份",
                subtitle: "由你定义。身份默认只保存在本机，允许分享后才会进入在线模型请求。"
            )
            TextField("角色名称", text: $model.identity.name)
            TextField("身份定位：它是谁、在这里扮演什么角色", text: $model.identity.role, axis: .vertical)
                .lineLimit(2...3)
            TextField("背景", text: $model.identity.background, axis: .vertical).lineLimit(2...5)
            TextField("性格：稳定的性格特点和相处方式", text: $model.identity.personality, axis: .vertical)
                .lineLimit(2...4)
            TextField("核心价值：遇到选择时优先坚持什么", text: $model.identity.values, axis: .vertical)
                .lineLimit(2...4)
            TextField("愿望与方向：它想持续做好什么", text: $model.identity.motivations, axis: .vertical)
                .lineLimit(2...4)
            TextField("与用户的关系：如何理解彼此", text: $model.identity.relationship, axis: .vertical)
                .lineLimit(2...3)
            TextField("表达方式", text: $model.identity.speakingStyle, axis: .vertical).lineLimit(2...4)
            TextField("知识与擅长边界：知道什么、不确定什么", text: $model.identity.knowledgeScope, axis: .vertical)
                .lineLimit(2...4)
            TextField("边界与不能假装知道的事", text: $model.identity.boundaries, axis: .vertical).lineLimit(2...4)
            Toggle("允许在线模型使用这份身份资料", isOn: $model.identity.shareWithOnlineModel)
            HStack {
                Button("保存身份", action: model.saveIdentity)
                    .buttonStyle(CharacterActionButtonStyle())
                    .disabled(!model.canSaveIdentity)
                Text(model.status).font(.callout).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(20)
    }
}
