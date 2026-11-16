import CharacterCore
import SwiftUI

public struct CharacterChatView: View {
    @ObservedObject private var model: CharacterWorkspaceModel
    @State private var confirmsClear = false
    @FocusState private var composerFocused: Bool

    public init(model: CharacterWorkspaceModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Menu {
                    Button("清空本轮聊天…", role: .destructive) { confirmsClear = true }
                        .disabled(model.isChatSending || model.chatTurns.isEmpty)
                } label: {
                    Label("聊天选项", systemImage: "ellipsis.circle").labelStyle(.iconOnly)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("聊天选项")
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
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
                if model.chatTurns.isEmpty {
                    CharacterChatWelcomeView(name: model.identity.displayName)
                        .contentShape(Rectangle())
                        .onTapGesture { composerFocused = false }
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 10) {
                                ForEach(model.chatTurns) { turn in
                                    CharacterChatMessageView(turn: turn)
                                }
                                if model.isChatSending {
                                    HStack(spacing: 8) {
                                        ProgressView().controlSize(.small)
                                        Text("等待回复…").foregroundStyle(.secondary)
                                    }
                                    .padding(.horizontal, 4)
                                }
                            }
                            .padding(20)
                        }
                        .onChange(of: model.chatTurns.last?.id) { id in
                            if let id {
                                withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { composerFocused = false }
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
                            Button("恢复输入") { model.restoreFailedChatDraft() }
                                .buttonStyle(.link)
                                .disabled(!model.chatDraft.isEmpty)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 10)
                    }
                    if !model.chatStatus.isEmpty {
                        Text(model.chatStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.top, 8)
                    }
                    CharacterChatComposer(model: model, isFocused: $composerFocused)
                        .padding(.horizontal, 20)
                        .padding(.top, 12)
                        .padding(.bottom, 16)
                }
            }
        }
        .onAppear { model.refreshChatModels() }
        .onDisappear { composerFocused = false }
        .onExitCommand { composerFocused = false }
        .confirmationDialog("清空本轮聊天？", isPresented: $confirmsClear, titleVisibility: .visible) {
            Button("清空本轮聊天", role: .destructive, action: model.clearChat)
            Button("取消", role: .cancel) {}
        } message: {
            Text("只移除当前窗口的对话，不删除输入草稿、长期记忆或目标。")
        }
    }

}
