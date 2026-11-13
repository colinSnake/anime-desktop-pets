import CharacterCore
import SwiftUI

public struct CharacterChatView: View {
    @ObservedObject private var model: CharacterWorkspaceModel
    @State private var draft = ""

    public init(model: CharacterWorkspaceModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 0) {
            if model.chat == nil {
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 28))
                        .foregroundStyle(.secondary)
                    Text("聊天尚未配置").font(.headline)
                    Text("请先在模型管理中配置在线模型；本窗口不会自动发起网络请求。")
                        .font(.callout).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(40)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if model.chatTurns.isEmpty {
                                Text("这是本轮临时聊天。角色会使用已确认的身份、相关记忆、角色知识和实时能力；聊天内容不会自动写入长期记忆。\n\n你可以明确说“记住……”来提交一条记忆，低风险内容会按本机规则处理，敏感或冲突内容需要审核。")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(14)
                                    .background(CharacterUIStyle.cardBackground)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            ForEach(Array(model.chatTurns.enumerated()), id: \.offset) { index, turn in
                                chatBubble(turn).id(index)
                            }
                            if model.isChatSending {
                                HStack(spacing: 8) {
                                    ProgressView().controlSize(.small)
                                    Text("正在回复…").foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 4)
                            }
                        }
                        .padding(20)
                    }
                    .onChange(of: model.chatTurns.count) { _ in
                        if let last = model.chatTurns.indices.last {
                            withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                        }
                    }
                }

            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.chat != nil {
                VStack(alignment: .leading, spacing: 0) {
                    if model.failedChatText != nil && !model.isChatSending {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.circle")
                                .foregroundStyle(.orange)
                            Text("上一条消息没有得到回复。")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            Button("重试") { model.retryFailedChat() }
                                .buttonStyle(.link)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 10)
                    }
                    if !model.status.isEmpty {
                        Text(model.status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.top, 8)
                    }
                    Divider().padding(.top, 10)
                    HStack(alignment: .bottom, spacing: 10) {
                        TextField("和龙妹聊聊……", text: $draft, axis: .vertical)
                            .lineLimit(2...5)
                            .textFieldStyle(.plain)
                            .frame(minHeight: 42, maxHeight: 72)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                            .overlay {
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(Color(nsColor: .separatorColor).opacity(0.55), lineWidth: 0.7)
                            }
                            .onSubmit { send() }
                        Button("发送") { send() }
                            .buttonStyle(CharacterActionButtonStyle())
                            .frame(minHeight: 36)
                            .disabled(model.isChatSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("清空") { draft = ""; model.clearChat() }
                            .frame(minHeight: 36)
                            .disabled(model.isChatSending || model.chatTurns.isEmpty)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .background(CharacterUIStyle.cardBackground)
            }
        }
    }

    @ViewBuilder
    private func chatBubble(_ turn: CharacterChatTurn) -> some View {
        HStack {
            if turn.role == .assistant { bubble(turn.text, tint: .accentColor); Spacer(minLength: 48) }
            else { Spacer(minLength: 48); bubble(turn.text, tint: .secondary) }
        }
    }

    private func bubble(_ text: String, tint: Color) -> some View {
        Text(text)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .foregroundStyle(.primary)
            .background(tint.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func send() {
        let text = draft
        guard CharacterChatSession.validatedInput(text) != nil else {
            model.sendChat(text)
            return
        }
        draft = ""
        model.sendChat(text)
    }
}
