import AppKit

@MainActor
final class ModelManagerWindow: NSWindowController, NSWindowDelegate {
    private let store: ModelProviderStore
    private let keyStore = ModelAPIKeyStore()
    private var settings: ModelProviderSettings
    private let provider = NSPopUpButton()
    private let baseURL = NSTextField(string: "")
    private let model = NSTextField(string: "")
    private let apiKey = NSSecureTextField(string: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let saveButton = NSButton(title: "保存", target: nil, action: nil)
    private let testButton = NSButton(title: "测试连接（可能计费）", target: nil, action: nil)
    private let removeKeyButton = NSButton(title: "删除已保存 Key", target: nil, action: nil)
    private var hasSavedKey = false

    init(store: ModelProviderStore) throws {
        self.store = store
        settings = try store.load()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 390),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "模型管理"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        buildContent()
        apply(settings)
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    private func buildContent() {
        guard let content = window?.contentView else { return }
        let title = NSTextField(labelWithString: "在线模型服务")
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString:
            "语音识别仍在本机运行；识别文本会发送到下方服务商生成回复。GPT、Codex、Grok 等可通过兼容中转填写模型名称和中转 Key；Codex 订阅登录不能直接代替 API Key。Key 存在 macOS 钥匙串。调用与测试可能计费，费用按服务商/中转站单价结算，本应用无法预估或限制账单。天气查询会把城市名称发送给 Open-Meteo。")
        note.textColor = .secondaryLabelColor

        provider.addItems(withTitles: ["OpenAI API", "DeepSeek", "自定义 / 中转站（GPT、Codex、Grok 等）"])
        provider.target = self
        provider.action = #selector(providerChanged)
        baseURL.placeholderString = "例如 https://api.openai.com/v1"
        model.placeholderString = "例如 gpt-4o-mini、deepseek-chat、grok-3 或中转提供的名称"
        apiKey.placeholderString = "留空则保留已保存的 Key；输入新 Key 将替换"
        for field in [baseURL, model, apiKey] {
            field.maximumNumberOfLines = 1
            field.usesSingleLineMode = true
        }
        status.textColor = .secondaryLabelColor

        saveButton.target = self
        saveButton.action = #selector(saveSettings)
        testButton.target = self
        testButton.action = #selector(testConnection)
        removeKeyButton.target = self
        removeKeyButton.action = #selector(removeSavedKey)
        let actions = NSStackView(views: [removeKeyButton, testButton, saveButton])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8

        let grid = NSGridView(views: [
            [label("提供商"), provider],
            [label("Base URL"), baseURL],
            [label("模型名称"), model],
            [label("API Key"), apiKey],
        ])
        grid.rowSpacing = 14
        grid.columnSpacing = 12
        grid.xPlacement = .leading
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 0).width = 82
        for field in [baseURL, model, apiKey] {
            field.widthAnchor.constraint(greaterThanOrEqualToConstant: 380).isActive = true
        }
        let stack = NSStackView(views: [title, note, grid, status, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -20),
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func label(_ value: String) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.textColor = .secondaryLabelColor
        return field
    }

    private func apply(_ value: ModelProviderSettings) {
        settings = value
        let index = ["openai", "deepseek", "openai-compatible"].firstIndex(of: value.provider) ?? 2
        provider.selectItem(at: index)
        baseURL.stringValue = value.baseURL
        model.stringValue = value.model
        do {
            hasSavedKey = try keyStore.read()?.isEmpty == false
            apiKey.stringValue = ""
            status.stringValue = hasSavedKey ? "API Key 已保存在 macOS 钥匙串。" : "尚未保存 API Key。"
        } catch { status.stringValue = error.localizedDescription }
    }

    @objc private func providerChanged() {
        switch provider.indexOfSelectedItem {
        case 0:
            baseURL.stringValue = "https://api.openai.com/v1"
            if model.stringValue.isEmpty || model.stringValue == "deepseek-chat" { model.stringValue = "gpt-4o-mini" }
        case 1:
            baseURL.stringValue = "https://api.deepseek.com"
            if model.stringValue.isEmpty || model.stringValue.hasPrefix("gpt-") { model.stringValue = "deepseek-chat" }
        default: break
        }
    }

    private func readControls() throws -> ModelProviderSettings {
        var next = ModelProviderSettings()
        next.provider = ["openai", "deepseek", "openai-compatible"].indices.contains(provider.indexOfSelectedItem)
            ? ["openai", "deepseek", "openai-compatible"][provider.indexOfSelectedItem]
            : "openai-compatible"
        next.baseURL = baseURL.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        next.model = model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        try next.validate()
        return next
    }

    @objc private func saveSettings() {
        do {
            let next = try readControls()
            try store.save(next)
            let key = apiKey.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty { try keyStore.save(key); hasSavedKey = true }
            settings = next
            apiKey.stringValue = ""
            status.stringValue = "模型设置已保存。"
        } catch { status.stringValue = error.localizedDescription }
    }

    @objc private func testConnection() {
        do {
            let next = try readControls()
            let enteredKey = apiKey.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = enteredKey.isEmpty ? try keyStore.read() : enteredKey
            guard let key, !key.isEmpty else { throw ModelProviderError.missingAPIKey }
            testButton.isEnabled = false
            status.stringValue = "正在发送最小测试请求…"
            Task {
                do {
                    let reply = try await ModelProviderClient().complete(
                        settings: next, apiKey: key, userText: "只回复OK", maxTokens: 8
                    )
                    await MainActor.run {
                        self.testButton.isEnabled = true
                        self.status.stringValue = "连接成功，模型回复：\(reply.prefix(80))"
                    }
                } catch {
                    await MainActor.run {
                        self.testButton.isEnabled = true
                        self.status.stringValue = error.localizedDescription
                    }
                }
            }
        } catch { status.stringValue = error.localizedDescription }
    }

    @objc private func removeSavedKey() {
        do {
            try keyStore.delete()
            hasSavedKey = false
            apiKey.stringValue = ""
            status.stringValue = "已从 macOS 钥匙串删除 API Key。"
        } catch { status.stringValue = error.localizedDescription }
    }
}
