import AppKit
import SwiftUI

@MainActor
final class ModelManagerWindow: NSViewController, ObservableObject {
    private let store: ModelProviderStore
    private let keyStore = ModelAPIKeyStore()
    private var settings: ModelProviderSettings
    fileprivate let offlinePreview: Bool

    @Published var providerIndex = 0
    @Published var baseURL = ""
    @Published var modelName = ""
    @Published var apiKey = ""
    @Published private(set) var status = ""
    @Published private(set) var hasSavedKey = false
    @Published private(set) var isTesting = false

    init(store: ModelProviderStore, offlinePreview: Bool = false) throws {
        self.store = store
        self.offlinePreview = offlinePreview
        settings = try store.load()
        super.init(nibName: nil, bundle: nil)
        view = NSView()
        installSwiftUIPage()
        apply(settings)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    private func installSwiftUIPage() {
        let host = NSHostingController(rootView: ModelManagerPage(model: self))
        addChild(host)
        let hostedView = host.view
        hostedView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hostedView)
        NSLayoutConstraint.activate([
            hostedView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostedView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hostedView.topAnchor.constraint(equalTo: view.topAnchor),
            hostedView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private func apply(_ value: ModelProviderSettings) {
        settings = value
        providerIndex = ["openai", "deepseek", "openai-compatible"].firstIndex(of: value.provider) ?? 2
        baseURL = value.baseURL
        modelName = value.model
        apiKey = ""
        if offlinePreview {
            hasSavedKey = false
            status = "离线预览：模型配置、钥匙串和网络操作已禁用。"
        } else {
            hasSavedKey = keyStore.hasValue()
            status = hasSavedKey ? "API Key 已保存在 macOS 钥匙串。" : "尚未保存 API Key。"
        }
    }

    func providerChanged(to index: Int) {
        providerIndex = index
        switch index {
        case 0:
            baseURL = "https://api.openai.com/v1"
            if modelName.isEmpty || modelName == "deepseek-chat" { modelName = "gpt-4o-mini" }
        case 1:
            baseURL = "https://api.deepseek.com"
            if modelName.isEmpty || modelName.hasPrefix("gpt-") { modelName = "deepseek-chat" }
        default: break
        }
    }

    private func readSettings() throws -> ModelProviderSettings {
        var next = ModelProviderSettings()
        next.provider = ["openai", "deepseek", "openai-compatible"].indices.contains(providerIndex)
            ? ["openai", "deepseek", "openai-compatible"][providerIndex]
            : "openai-compatible"
        next.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        next.model = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        try next.validate()
        return next
    }

    func saveSettings() {
        guard !offlinePreview else { return }
        do {
            let next = try readSettings()
            try store.save(next)
            let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                try keyStore.save(key)
                hasSavedKey = true
            }
            settings = next
            apiKey = ""
            status = "模型设置已保存。"
        } catch {
            status = error.localizedDescription
        }
    }

    func testConnection() {
        guard !offlinePreview, !isTesting else { return }
        do {
            let next = try readSettings()
            let enteredKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = enteredKey.isEmpty ? try keyStore.read() : enteredKey
            guard let key, !key.isEmpty else { throw ModelProviderError.missingAPIKey }
            isTesting = true
            status = "正在发送最小测试请求…"
            Task { [weak self] in
                do {
                    let reply = try await ModelProviderClient().complete(
                        settings: next, apiKey: key, userText: "只回复OK", maxTokens: 8
                    )
                    self?.status = "连接成功，模型回复：\(reply.prefix(80))"
                } catch {
                    self?.status = error.localizedDescription
                }
                self?.isTesting = false
            }
        } catch {
            status = error.localizedDescription
        }
    }

    func removeSavedKey() {
        guard !offlinePreview else { return }
        do {
            try keyStore.delete()
            hasSavedKey = false
            apiKey = ""
            status = "已从 macOS 钥匙串删除 API Key。"
        } catch {
            status = error.localizedDescription
        }
    }
}

private struct ModelManagerPage: View {
    @ObservedObject var model: ModelManagerWindow
    private let providers = ["OpenAI API", "DeepSeek", "自定义 / 中转站（GPT、Codex、Grok 等）"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WorkspaceSectionCard(title: "服务连接") {
                    VStack(alignment: .leading, spacing: 12) {
                        field("提供商") {
                            Picker("提供商", selection: Binding(get: { model.providerIndex }, set: { model.providerChanged(to: $0) })) {
                                ForEach(providers.indices, id: \.self) { index in Text(providers[index]).tag(index) }
                            }
                            .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        }
                        field("Base URL") {
                            TextField("例如 https://api.openai.com/v1", text: $model.baseURL)
                                .textFieldStyle(.roundedBorder)
                        }
                        field("模型名称") {
                            TextField("例如 gpt-4o-mini、deepseek-chat 或中转提供的名称", text: $model.modelName)
                                .textFieldStyle(.roundedBorder)
                        }
                        field("API Key") {
                            SecureField("留空则保留已保存的 Key；输入新 Key 将替换", text: $model.apiKey)
                                .textFieldStyle(.roundedBorder)
                        }
                    }
                }
                WorkspaceSectionCard(title: "凭证与费用") {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(model.hasSavedKey ? "API Key 已保存在 macOS 钥匙串" : "尚未保存 API Key", systemImage: model.hasSavedKey ? "key.fill" : "key")
                            .font(.system(size: 13, weight: .medium))
                        Text("语音识别在本机完成；仅生成回复时才会向所选服务商发送识别文本。连接测试会发送最小请求并可能产生费用，保存设置不会发起请求。")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                Text(model.status)
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("model-settings-status")
                HStack(spacing: 8) {
                    Button("测试连接（可能计费）", action: model.testConnection)
                        .disabled(model.offlinePreview || model.isTesting)
                    Button("保存", action: model.saveSettings)
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(WorkspaceActionButtonStyle(prominent: true))
                        .disabled(model.offlinePreview)
                    Button("删除已保存 Key", role: .destructive, action: model.removeSavedKey)
                        .disabled(model.offlinePreview || !model.hasSavedKey)
                }
            }
            .padding(22)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Color(nsColor: WorkspacePalette.canvas))
        .tint(Color(nsColor: WorkspacePalette.accent))
    }

    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            content()
        }
    }

}
