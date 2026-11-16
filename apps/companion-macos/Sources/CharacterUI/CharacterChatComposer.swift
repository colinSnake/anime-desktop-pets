import CharacterCore
import SwiftUI

/// SwiftUI's own text input, buttons and popover; no custom native window or editor.
struct CharacterChatComposer: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @FocusState.Binding var isFocused: Bool

    init(model: CharacterWorkspaceModel, isFocused: FocusState<Bool>.Binding) {
        self.model = model
        self._isFocused = isFocused
    }

    private var draftCharacterCount: Int {
        model.chatDraft.trimmingCharacters(in: .whitespacesAndNewlines).count
    }

    private var canSend: Bool {
        !model.isChatSending && CharacterChatSession.validatedInput(model.chatDraft) != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField("和\(model.identity.displayName)聊聊……", text: $model.chatDraft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(2...7)
                .focused($isFocused)
                .onSubmit { model.sendDraft() }
                .background(CharacterChatReturnKeyPolicy(text: $model.chatDraft))
                .accessibilityLabel("聊天消息")
                .accessibilityIdentifier("chat-composer-input")
            HStack(alignment: .center, spacing: 12) {
                Spacer(minLength: 0)
                if draftCharacterCount > 1_000 {
                    Text("\(draftCharacterCount)/\(CharacterChatSession.maxTextCharacters)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(draftCharacterCount > CharacterChatSession.maxTextCharacters ? Color.red : .secondary)
                        .accessibilityLabel("消息字数 \(draftCharacterCount)，上限 \(CharacterChatSession.maxTextCharacters)")
                }
                CharacterChatModelPicker(model: model)
                if model.isChatSending {
                    Button(action: model.cancelChat) {
                        Label("停止等待回复", systemImage: "stop.fill").labelStyle(.iconOnly)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .help("停止等待当前回复")
                    .accessibilityIdentifier("chat-composer-stop")
                } else if #available(macOS 14.0, *) {
                    sendButton.buttonBorderShape(.circle)
                } else {
                    sendButton
                }
            }
        }
        .padding(16)
        .modifier(CharacterInputSurface(isFocused: isFocused, cornerRadius: 20))
        .shadow(color: .black.opacity(0.04), radius: 8, y: 2)
        .onExitCommand { isFocused = false }
    }

    private var sendButton: some View {
        Button {
            model.sendDraft()
            isFocused = true
        } label: {
            Label(model.isChatSending ? "正在回复" : "发送消息", systemImage: model.isChatSending ? "ellipsis" : "arrow.up")
                .labelStyle(.iconOnly)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!canSend)
        .help("Enter 发送，Shift+Enter 换行")
        .accessibilityIdentifier("chat-composer-send")
    }
}
