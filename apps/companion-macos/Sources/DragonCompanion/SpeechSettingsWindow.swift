import AppKit
import UniformTypeIdentifiers

@MainActor
final class SpeechSettingsWindow: NSViewController {
    private let store: SpeechSettingsStore
    private var settings: SpeechSettings
    var onDemo: ((SpeechSettings, @escaping (Result<String, Error>) -> Void) -> Void)?
    var onCancelVoice: (() -> Void)?
    var onSettingsSaved: ((SpeechSettings) -> Void)?
    var onDiagnostic: ((String) -> Void)?
    var onVoiceChat: ((URL, SpeechSettings, @escaping (String) -> Void,
                       @escaping (Result<String, Error>) -> Void) -> Void)?
    private let voiceRecorder = VoiceInputRecorder()
    private let platform = NSPopUpButton()
    private let microphone = NSPopUpButton()
    private let microphoneTest = NSButton(title: "检测麦克风", target: nil, action: nil)
    private let microphoneMeter = NSLevelIndicator()
    private var microphoneDevices: [AudioInputDevice] = []
    private var isTestingMicrophone = false
    private let room = NSTextField(string: "")
    private let reference = NSTextField(labelWithString: "未选择")
    private let transcript = NSTextField(string: "")
    private let display = NSButton(checkboxWithTitle: "在桌宠气泡中显示生成的回复", target: nil, action: nil)
    private let speak = NSButton(checkboxWithTitle: "朗读生成的回复（播放到扬声器）", target: nil, action: nil)
    private let speakInteractive = NSButton(checkboxWithTitle: "朗读桌宠互动气泡", target: nil, action: nil)
    private let status = NSTextField(wrappingLabelWithString: "回复由“模型管理”中配置的在线服务生成；语音识别在本机完成。")
    private let saveButton = NSButton(title: "保存", target: nil, action: nil)
    private let demoButton = NSButton(title: "运行在线模型演示", target: nil, action: nil)
    private let voiceChatButton = NSButton(title: "开始语音聊天", target: nil, action: nil)
    private let clearReference = NSButton(title: "移除", target: nil, action: nil)

    init(store: SpeechSettingsStore, offlinePreview: Bool = false) throws {
        self.store = store
        settings = try store.load()
        super.init(nibName: nil, bundle: nil)
        view = NSView()
        voiceRecorder.onDiagnostic = { [weak self] event in self?.onDiagnostic?(event) }
        buildContent()
        apply(settings)
        if offlinePreview {
            microphoneTest.isEnabled = false
            demoButton.isEnabled = false
            voiceChatButton.isEnabled = false
            saveButton.isEnabled = false
            status.stringValue = "离线预览：麦克风、模型请求和设置保存已禁用。"
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    func stopForWindowClose() {
        voiceRecorder.cancel()
        onCancelVoice?()
        isTestingMicrophone = false
    }

    func setInteractiveBubbleSpeechEnabled(_ enabled: Bool) {
        settings.speakInteractiveBubbles = enabled
        speakInteractive.state = enabled ? .on : .off
    }

    private func buildContent() {
        let content = view
        let title = NSTextField(labelWithString: "直播语音")
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString:
            "语音聊天会录制最多20秒并在本机识别；识别文本会发送到“模型管理”配置的服务商。不连接直播间。只有选择有权使用的参考音频并勾选朗读，才会本机合成克隆音色。")
        note.textColor = .secondaryLabelColor

        platform.addItems(withTitles: ["B站（接入开发中）", "抖音（接入待评估）"])
        microphone.target = self
        microphone.action = #selector(microphoneChanged)
        microphoneTest.target = self
        microphoneTest.action = #selector(testMicrophone)
        microphoneMeter.levelIndicatorStyle = .continuousCapacity
        microphoneMeter.minValue = 0
        microphoneMeter.maxValue = 1
        microphoneMeter.warningValue = 0.22
        microphoneMeter.criticalValue = 0.55
        microphoneMeter.isEnabled = true
        microphoneMeter.widthAnchor.constraint(equalToConstant: 100).isActive = true
        microphoneMeter.heightAnchor.constraint(equalToConstant: 16).isActive = true
        refreshMicrophones()
        room.placeholderString = "直播间号或房间标识"
        room.maximumNumberOfLines = 1
        transcript.placeholderString = "参考音频的准确逐字转写（必填）"
        transcript.maximumNumberOfLines = 1

        let chooseAudio = NSButton(title: "选择参考音频…", target: self, action: #selector(chooseReferenceAudio))
        clearReference.target = self
        clearReference.action = #selector(removeReferenceAudio)
        let referenceRow = NSStackView(views: [reference, chooseAudio, clearReference])
        referenceRow.orientation = .horizontal
        referenceRow.spacing = 8
        reference.setContentHuggingPriority(.defaultLow, for: .horizontal)
        chooseAudio.setContentHuggingPriority(.required, for: .horizontal)
        clearReference.setContentHuggingPriority(.required, for: .horizontal)

        display.target = self
        display.action = #selector(changedPreference)
        speak.target = self
        speak.action = #selector(changedPreference)
        speakInteractive.target = self
        speakInteractive.action = #selector(changedPreference)

        status.textColor = .secondaryLabelColor
        let credentialNote = NSTextField(wrappingLabelWithString:
            "API Key 在“模型管理”中单独保存至 macOS 钥匙串；语音设置、诊断日志和本地运行参数不保存 API Key。")
        credentialNote.textColor = .secondaryLabelColor
        credentialNote.font = .systemFont(ofSize: 11)

        saveButton.target = self
        saveButton.action = #selector(saveSettings)
        saveButton.keyEquivalent = "\r"
        demoButton.target = self
        demoButton.action = #selector(runDemo)
        voiceChatButton.target = self
        voiceChatButton.action = #selector(toggleVoiceChat)
        voiceRecorder.onInputLevel = { [weak self] level in
            self?.microphoneMeter.doubleValue = Double(level)
        }
        voiceRecorder.onLimitReached = { [weak self] url in
            guard let self else {
                if let url { try? FileManager.default.removeItem(at: url) }
                return
            }
            if self.isTestingMicrophone { self.finishMicrophoneTest(url) }
            else if let url { self.finishVoiceCapture(url) }
            else {
                self.voiceChatButton.isEnabled = true
                self.voiceChatButton.title = "开始语音聊天"
                self.status.stringValue = self.captureFailureMessage()
                let capture = self.voiceRecorder.captureSummary
                self.onDiagnostic?("speech.capture.finished result=\(capture.resultDescription) sample-buffers=\(capture.sampleBuffers) decoded-buffers=\(capture.decodedBuffers) written-buffers=\(capture.writtenBuffers)")
            }
        }
        let actions = NSStackView(views: [demoButton, saveButton])
        actions.orientation = .horizontal
        actions.spacing = 8
        let footer = NSStackView(views: [status, actions])
        footer.orientation = .horizontal
        footer.spacing = 12
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)
        saveButton.setContentHuggingPriority(.required, for: .horizontal)
        demoButton.setContentHuggingPriority(.required, for: .horizontal)

        let fields = NSGridView(views: [
            [label("直播平台"), platform],
            [label("直播间"), room],
            [label("麦克风"), microphoneControls()],
            [label("参考音频"), referenceRow],
            [label("准确转写"), transcript],
        ])
        fields.rowSpacing = 14
        fields.columnSpacing = 12
        fields.xPlacement = .leading
        fields.translatesAutoresizingMaskIntoConstraints = false
        fields.column(at: 0).xPlacement = .trailing
        fields.column(at: 0).width = 76
        room.widthAnchor.constraint(greaterThanOrEqualToConstant: 300).isActive = true
        transcript.widthAnchor.constraint(greaterThanOrEqualToConstant: 300).isActive = true

        let stack = NSStackView(views: [title, note, fields, display, speak, speakInteractive, voiceChatButton, credentialNote, footer])
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
            fields.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func label(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.textColor = .secondaryLabelColor
        return field
    }

    private func microphoneControls() -> NSView {
        let row = NSStackView(views: [microphone, microphoneTest, microphoneMeter])
        row.orientation = .horizontal
        row.spacing = 8
        microphone.setContentHuggingPriority(.defaultLow, for: .horizontal)
        microphoneTest.setContentHuggingPriority(.required, for: .horizontal)
        microphoneMeter.setContentHuggingPriority(.required, for: .horizontal)
        return row
    }

    private func refreshMicrophones() {
        microphone.removeAllItems()
        do {
            microphoneDevices = try AudioInputDevice.available()
            for device in microphoneDevices {
                microphone.addItem(withTitle: device.name)
                microphone.lastItem?.representedObject = device.id
            }
            if microphoneDevices.isEmpty {
                microphone.addItem(withTitle: "未发现麦克风")
                microphone.isEnabled = false
                microphoneTest.isEnabled = false
                return
            }
            microphone.isEnabled = true
            microphoneTest.isEnabled = true
            let selected = microphoneDevices.first { $0.id == settings.microphoneUID }
                ?? microphoneDevices.first(where: { $0.name.contains("（系统默认）") })
                ?? microphoneDevices[0]
            microphone.selectItem(withTitle: selected.name)
            settings.microphoneUID = selected.id
        } catch {
            microphoneDevices = []
            microphone.addItem(withTitle: "无法读取设备")
            microphone.isEnabled = false
            microphoneTest.isEnabled = false
            status.stringValue = error.localizedDescription
        }
    }

    private func apply(_ value: SpeechSettings) {
        settings = value
        platform.selectItem(at: value.platform == "douyin" ? 1 : 0)
        room.stringValue = value.roomIdentifier
        if let device = microphoneDevices.first(where: { $0.id == value.microphoneUID })
            ?? microphoneDevices.first(where: { $0.name.contains("（系统默认）") })
            ?? microphoneDevices.first {
            microphone.selectItem(withTitle: device.name)
            settings.microphoneUID = device.id
        }
        display.state = value.displayReplies ? .on : .off
        speak.state = value.speakReplies ? .on : .off
        speakInteractive.state = value.speakInteractiveBubbles ? .on : .off
        if !value.referenceAudioPath.isEmpty {
            reference.stringValue = URL(fileURLWithPath: value.referenceAudioPath).lastPathComponent
            reference.toolTip = value.referenceAudioPath
        }
        transcript.stringValue = value.referenceTranscript
        clearReference.isEnabled = !value.referenceAudioPath.isEmpty
        if let uid = value.microphoneUID,
           !microphoneDevices.contains(where: { $0.id == uid }) {
            status.stringValue = "之前选择的麦克风不可用；当前已切换为系统默认输入。"
        }
    }

    @objc private func changedPreference() {
        settings.displayReplies = display.state == .on
        settings.speakReplies = speak.state == .on
        settings.speakInteractiveBubbles = speakInteractive.state == .on
        settings.referenceTranscript = transcript.stringValue
    }

    @objc private func microphoneChanged() {
        settings.microphoneUID = microphone.selectedItem?.representedObject as? String
        status.stringValue = "麦克风选择已更改；保存后用于语音聊天。"
    }

    @objc private func testMicrophone() {
        guard !voiceRecorder.isRecording else { return }
        onDiagnostic?("speech.microphone-test.permission-requested")
        microphoneTest.isEnabled = false
        microphone.isEnabled = false
        microphoneTest.title = "检测中…"
        microphoneMeter.doubleValue = 0
        voiceRecorder.start(deviceUID: microphone.selectedItem?.representedObject as? String,
                            duration: 4) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.isTestingMicrophone = true
                self.onDiagnostic?("speech.microphone-test.started")
                self.status.stringValue = "请对着所选麦克风说话或轻声拍手，正在检测输入电平…"
            case .failure(let error):
                self.resetMicrophoneTest()
                self.status.stringValue = error.localizedDescription
            }
        }
    }

    private func finishMicrophoneTest(_ url: URL?) {
        let bytes = url.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? NSNumber }?.intValue ?? 0
        if let url { try? FileManager.default.removeItem(at: url) }
        isTestingMicrophone = false
        let detected = voiceRecorder.peakLevel >= 0.02
        let capture = voiceRecorder.captureSummary
        onDiagnostic?("speech.microphone-test.finished result=\(capture.resultDescription) sample-buffers=\(capture.sampleBuffers) decoded-buffers=\(capture.decodedBuffers) written-buffers=\(capture.writtenBuffers) bytes=\(bytes) level=\(detected ? "signal" : "quiet")")
        resetMicrophoneTest()
        status.stringValue = capture.sampleBuffers == 0
            ? capture.sessionErrorCode.map { "麦克风采集会话发生系统错误（代码 \($0)）；请检查设备占用或重新选择输入设备。" }
                ?? "系统没有送来麦克风音频帧；请检查权限，或在系统设置中选择并启用正确的输入设备。"
            : capture.decodedBuffers == 0
            ? "系统已送来音频帧，但应用解码失败（\(capture.firstFailure ?? "未知阶段")）；诊断信息已记录。"
            : capture.writtenBuffers == 0
            ? "音频已解码，但无法转换或写入录音文件（\(capture.firstFailure ?? "未知阶段")）；诊断信息已记录。"
            : detected
            ? "检测到麦克风输入；音量条显示刚才采到的声音强度。"
            : "没有检测到明显声音；请检查所选设备、输入音量和系统麦克风权限。"
    }

    private func resetMicrophoneTest() {
        isTestingMicrophone = false
        microphoneTest.title = "检测麦克风"
        microphoneTest.isEnabled = !microphoneDevices.isEmpty
        microphone.isEnabled = !microphoneDevices.isEmpty
    }

    @objc private func chooseReferenceAudio() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.title = "选择有权使用的参考音频"
        panel.prompt = "选择音频"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            settings.referenceAudioBookmark = try url.bookmarkData(options: .withSecurityScope,
                                                                    includingResourceValuesForKeys: nil,
                                                                    relativeTo: nil)
        } catch {
            do {
                settings.referenceAudioBookmark = try url.bookmarkData(options: [],
                                                                        includingResourceValuesForKeys: nil,
                                                                        relativeTo: nil)
            } catch {
                status.stringValue = "无法保存所选音频书签：\(error.localizedDescription)"
                return
            }
        }
        settings.referenceAudioPath = url.standardizedFileURL.path
        reference.stringValue = url.lastPathComponent
        reference.toolTip = url.path
        clearReference.isEnabled = true
        status.stringValue = "参考音频已选择；请保存设置。"
    }

    @objc private func removeReferenceAudio() {
        settings.referenceAudioPath = ""
        settings.referenceAudioBookmark = nil
        reference.stringValue = "未选择"
        reference.toolTip = nil
        clearReference.isEnabled = false
        status.stringValue = "参考音频已移除；请保存设置。"
    }

    @objc private func saveSettings() {
        readControls()
        do {
            try store.save(settings)
            onSettingsSaved?(settings)
            status.stringValue = "设置已保存到本机；尚未启动推理或连接直播间。"
        } catch {
            status.stringValue = error.localizedDescription
        }
    }

    @objc private func runDemo() {
        readControls()
        guard !settings.referenceAudioPath.isEmpty, settings.referenceAudioBookmark != nil,
              !settings.referenceTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            status.stringValue = "请先选择参考音频并填写准确转写。"
            return
        }
        do { try store.save(settings) }
        catch { status.stringValue = error.localizedDescription; return }
        onSettingsSaved?(settings)
        guard let onDemo else {
            status.stringValue = "本机演示协调器不可用。"
            return
        }
        demoButton.isEnabled = false
        status.stringValue = settings.speakReplies ? "正在请求在线模型并准备朗读…" : "正在请求在线模型…"
        onDemo(settings) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.demoButton.isEnabled = true
                switch result {
                case .success(let message): self.status.stringValue = message
                case .failure(let error): self.status.stringValue = error.localizedDescription
                }
            }
        }
    }

    @objc private func toggleVoiceChat() {
        if voiceRecorder.isRecording {
            guard let url = voiceRecorder.stop() else {
                voiceChatButton.title = "开始语音聊天"
                status.stringValue = captureFailureMessage()
                let capture = voiceRecorder.captureSummary
                onDiagnostic?("speech.capture.empty result=\(capture.resultDescription) sample-buffers=\(capture.sampleBuffers) decoded-buffers=\(capture.decodedBuffers) written-buffers=\(capture.writtenBuffers)")
                return
            }
            finishVoiceCapture(url)
            return
        }

        readControls()
        do { try store.save(settings) }
        catch { status.stringValue = error.localizedDescription; return }
        onSettingsSaved?(settings)
        voiceChatButton.isEnabled = false
        status.stringValue = "正在请求麦克风权限…"
        onDiagnostic?("speech.capture.permission-requested")
        voiceRecorder.start(deviceUID: settings.microphoneUID) { [weak self] result in
            guard let self else { return }
            self.voiceChatButton.isEnabled = true
            switch result {
            case .success:
                self.voiceChatButton.title = "停止并发送"
                self.status.stringValue = "正在录音；再次点击发送，最长20秒。"
                self.onDiagnostic?("speech.capture.started")
            case .failure(let error):
                self.voiceChatButton.title = "开始语音聊天"
                self.status.stringValue = error.localizedDescription
                self.onDiagnostic?("speech.capture.start-failed")
            }
        }
    }

    private func finishVoiceCapture(_ url: URL) {
        voiceChatButton.title = "开始语音聊天"
        voiceChatButton.isEnabled = false
        status.stringValue = "正在本机识别并生成回复…"
        let byteCount = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        onDiagnostic?("speech.capture.submitted bytes=\(byteCount)")
        guard let onVoiceChat else {
            try? FileManager.default.removeItem(at: url)
            voiceChatButton.isEnabled = true
            status.stringValue = "本机语音聊天协调器不可用。"
            onDiagnostic?("speech.capture.coordinator-unavailable")
            return
        }
        var recognizedTranscript: String?
        onVoiceChat(url, settings, { [weak self] text in
            recognizedTranscript = text
            self?.onDiagnostic?("speech.asr.transcribed characters=\(text.count)")
            DispatchQueue.main.async { self?.status.stringValue = "识别到：\(text)" }
        }) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.voiceChatButton.isEnabled = true
                let transcriptPrefix = recognizedTranscript.map { text in
                    "识别到：\(text.prefix(160))\(text.count > 160 ? "…" : "")；"
                } ?? ""
                switch result {
                case .success(let message):
                    self.status.stringValue = transcriptPrefix + message
                    self.onDiagnostic?("speech.capture.finished result=success")
                case .failure(let error):
                    self.status.stringValue = transcriptPrefix + error.localizedDescription
                    self.onDiagnostic?("speech.capture.finished result=failure")
                }
            }
        }
    }

    private func captureFailureMessage() -> String {
        let capture = voiceRecorder.captureSummary
        switch capture.resultDescription {
        case "no-sample-buffers":
            if let code = capture.sessionErrorCode {
                return "麦克风采集会话发生系统错误（代码 \(code)）；请检查输入设备或重新选择麦克风。"
            }
            return "没有收到系统麦克风音频；请检查权限及所选输入设备。"
        case "sample-decode-failed":
            return "系统已送来音频，但应用解码失败（\(capture.firstFailure ?? "未知阶段")）；没有把空录音发送给识别模型。"
        case "pcm-write-failed":
            return "音频已解码，但录音文件写入失败（\(capture.firstFailure ?? "未知阶段")）；没有发送给识别模型。"
        default:
            return "没有生成可识别的录音文件；请重新检测麦克风后再试。"
        }
    }

    private func readControls() {
        settings.platform = platform.indexOfSelectedItem == 1 ? "douyin" : "bilibili"
        settings.microphoneUID = microphone.selectedItem?.representedObject as? String
        settings.roomIdentifier = room.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.referenceTranscript = transcript.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.displayReplies = display.state == .on
        settings.speakReplies = speak.state == .on
    }
}
