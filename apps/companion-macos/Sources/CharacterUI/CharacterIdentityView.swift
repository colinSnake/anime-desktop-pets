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
            TextField("背景", text: $model.identity.background, axis: .vertical).lineLimit(2...5)
            TextField("性格", text: $model.identity.personality, axis: .vertical).lineLimit(2...4)
            TextField("表达方式", text: $model.identity.speakingStyle, axis: .vertical).lineLimit(2...4)
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
