import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class SpeechSettingsWindow: NSViewController, ObservableObject {
    enum Page { case voice, live }

    private let store: SpeechSettingsStore
    private var settings: SpeechSettings
    let offlinePreview: Bool
    private let voiceRecorder = VoiceInputRecorder()
    private var microphoneDevices: [AudioInputDevice] = []
    private var isTestingMicrophone = false

    var onDemo: ((SpeechSettings, @escaping (Result<String, Error>) -> Void) -> Void)?
    var onCancelVoice: (() -> Void)?
    var onSettingsSaved: ((SpeechSettings) -> Void)?
    var onDiagnostic: ((String) -> Void)?
    var onVoiceChat: ((URL, SpeechSettings, @escaping (String) -> Void,
                       @escaping (Result<String, Error>) -> Void) -> Void)?

    @Published private(set) var page: Page = .voice
    @Published private(set) var microphoneChoices: [AudioInputDevice] = []
    @Published private(set) var microphoneAvailable = false
    @Published private(set) var microphoneTesting = false
    @Published private(set) var microphoneLevel = 0.0
    @Published private(set) var recording = false
    @Published private(set) var voiceTurnBusy = false
    @Published private(set) var demoBusy = false
    @Published private(set) var status = "语音识别在本机完成；在线回复使用模型管理中配置的服务。"
    @Published var platform = "bilibili"
    @Published var microphoneUID: String?
    @Published var roomIdentifier = ""
    @Published var referenceAudioPath = ""
    @Published var referenceTranscript = ""
    @Published var displayReplies = true
    @Published var speakReplies = false
    @Published var speakInteractiveBubbles = false

    init(store: SpeechSettingsStore, offlinePreview: Bool = false) throws {
        self.store = store
        settings = try store.load()
        self.offlinePreview = offlinePreview
        super.init(nibName: nil, bundle: nil)
        view = NSView()
        voiceRecorder.onDiagnostic = { [weak self] event in self?.onDiagnostic?(event) }
        voiceRecorder.onInputLevel = { [weak self] level in self?.microphoneLevel = Double(level) }
        voiceRecorder.onLimitReached = { [weak self] url in
            guard let self else {
                if let url { try? FileManager.default.removeItem(at: url) }
                return
            }
            if self.isTestingMicrophone { self.finishMicrophoneTest(url) }
            else if let url { self.finishVoiceCapture(url) }
            else {
                self.recording = false
                self.voiceTurnBusy = false
                self.status = self.captureFailureMessage()
                let capture = self.voiceRecorder.captureSummary
                self.onDiagnostic?("speech.capture.finished result=\(capture.resultDescription) sample-buffers=\(capture.sampleBuffers) decoded-buffers=\(capture.decodedBuffers) written-buffers=\(capture.writtenBuffers)")
            }
        }
        refreshMicrophones()
        apply(settings)
        installSwiftUIPage()
        if offlinePreview { status = "离线预览：麦克风、模型请求和设置保存已禁用。" }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    private func installSwiftUIPage() {
        let host = NSHostingController(rootView: SpeechSettingsPage(model: self))
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

    func stopForWindowClose() {
        voiceRecorder.cancel()
        onCancelVoice?()
        isTestingMicrophone = false
        microphoneTesting = false
        recording = false
        voiceTurnBusy = false
    }

    func setInteractiveBubbleSpeechEnabled(_ enabled: Bool) {
        settings.speakInteractiveBubbles = enabled
        speakInteractiveBubbles = enabled
    }

    func selectPage(_ page: Page) {
        self.page = page
        if offlinePreview {
            status = "离线预览：麦克风、模型请求和设置保存已禁用。"
        } else if page == .live {
            status = "直播平台尚未接入；保存只保留本地配置，不会连接直播间。"
        } else {
            status = "语音识别在本机完成；回复使用“模型管理”中配置的服务。"
        }
    }

    private func refreshMicrophones() {
        do {
            microphoneDevices = try AudioInputDevice.available()
            microphoneChoices = microphoneDevices
            microphoneAvailable = !microphoneDevices.isEmpty
            if let selected = microphoneDevices.first(where: { $0.id == settings.microphoneUID })
                ?? microphoneDevices.first(where: { $0.name.contains("（系统默认）") })
                ?? microphoneDevices.first {
                microphoneUID = selected.id
                settings.microphoneUID = selected.id
            }
        } catch {
            microphoneDevices = []
            microphoneChoices = []
            microphoneAvailable = false
            status = error.localizedDescription
        }
    }

    private func apply(_ value: SpeechSettings) {
        settings = value
        platform = value.platform
        roomIdentifier = value.roomIdentifier
        referenceAudioPath = value.referenceAudioPath
        referenceTranscript = value.referenceTranscript
        displayReplies = value.displayReplies
        speakReplies = value.speakReplies
        speakInteractiveBubbles = value.speakInteractiveBubbles
        if let device = microphoneDevices.first(where: { $0.id == value.microphoneUID })
            ?? microphoneDevices.first(where: { $0.name.contains("（系统默认）") })
            ?? microphoneDevices.first {
            microphoneUID = device.id
            settings.microphoneUID = device.id
        }
        if let uid = value.microphoneUID, !microphoneDevices.contains(where: { $0.id == uid }) {
            status = "之前选择的麦克风不可用；当前已切换为系统默认输入。"
        }
    }

    private func readControls() {
        settings.platform = platform == "douyin" ? "douyin" : "bilibili"
        settings.microphoneUID = microphoneUID
        settings.roomIdentifier = roomIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.referenceTranscript = referenceTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.displayReplies = displayReplies
        settings.speakReplies = speakReplies
        settings.speakInteractiveBubbles = speakInteractiveBubbles
    }

    func microphoneChanged(_ uid: String?) {
        microphoneUID = uid
        settings.microphoneUID = uid
        status = "麦克风选择已更改；保存后用于语音聊天。"
    }

    func testMicrophone() {
        guard !offlinePreview, microphoneAvailable, !voiceRecorder.isRecording, !voiceTurnBusy else { return }
        onDiagnostic?("speech.microphone-test.permission-requested")
        microphoneTesting = true
        microphoneLevel = 0
        voiceRecorder.start(deviceUID: microphoneUID, duration: 4) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.isTestingMicrophone = true
                self.onDiagnostic?("speech.microphone-test.started")
                self.status = "请对着所选麦克风说话或轻声拍手，正在检测输入电平…"
            case .failure(let error):
                self.resetMicrophoneTest()
                self.status = error.localizedDescription
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
        status = capture.sampleBuffers == 0
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
        microphoneTesting = false
    }

    func chooseReferenceAudio() {
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
                status = "无法保存所选音频书签：\(error.localizedDescription)"
                return
            }
        }
        settings.referenceAudioPath = url.standardizedFileURL.path
        referenceAudioPath = settings.referenceAudioPath
        status = "参考音频已选择；请保存设置。"
    }

    func removeReferenceAudio() {
        settings.referenceAudioPath = ""
        settings.referenceAudioBookmark = nil
        referenceAudioPath = ""
        status = "参考音频已移除；请保存设置。"
    }

    func saveSettings() {
        readControls()
        do {
            try store.save(settings)
            onSettingsSaved?(settings)
            status = "设置已保存到本机；尚未启动推理或连接直播间。"
        } catch {
            status = error.localizedDescription
        }
    }

    func runDemo() {
        guard !offlinePreview, !demoBusy else { return }
        readControls()
        guard !settings.referenceAudioPath.isEmpty, settings.referenceAudioBookmark != nil,
              !settings.referenceTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            status = "请先选择参考音频并填写准确转写。"
            return
        }
        do { try store.save(settings) }
        catch { status = error.localizedDescription; return }
        onSettingsSaved?(settings)
        guard let onDemo else {
            status = "本机演示协调器不可用。"
            return
        }
        demoBusy = true
        status = settings.speakReplies ? "正在请求在线模型并准备朗读…" : "正在请求在线模型…"
        onDemo(settings) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.demoBusy = false
                switch result {
                case .success(let message): self.status = message
                case .failure(let error): self.status = error.localizedDescription
                }
            }
        }
    }

    func toggleVoiceChat() {
        guard !offlinePreview, !voiceTurnBusy else { return }
        if voiceRecorder.isRecording {
            guard let url = voiceRecorder.stop() else {
                recording = false
                status = captureFailureMessage()
                let capture = voiceRecorder.captureSummary
                onDiagnostic?("speech.capture.empty result=\(capture.resultDescription) sample-buffers=\(capture.sampleBuffers) decoded-buffers=\(capture.decodedBuffers) written-buffers=\(capture.writtenBuffers)")
                return
            }
            finishVoiceCapture(url)
            return
        }

        readControls()
        do { try store.save(settings) }
        catch { status = error.localizedDescription; return }
        onSettingsSaved?(settings)
        voiceTurnBusy = true
        status = "正在请求麦克风权限…"
        onDiagnostic?("speech.capture.permission-requested")
        voiceRecorder.start(deviceUID: settings.microphoneUID) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.recording = true
                self.voiceTurnBusy = false
                self.status = "正在录音；再次点击发送，最长20秒。"
                self.onDiagnostic?("speech.capture.started")
            case .failure(let error):
                self.recording = false
                self.voiceTurnBusy = false
                self.status = error.localizedDescription
                self.onDiagnostic?("speech.capture.start-failed")
            }
        }
    }

    private func finishVoiceCapture(_ url: URL) {
        recording = false
        voiceTurnBusy = true
        status = "正在本机识别并生成回复…"
        let byteCount = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        onDiagnostic?("speech.capture.submitted bytes=\(byteCount)")
        guard let onVoiceChat else {
            try? FileManager.default.removeItem(at: url)
            voiceTurnBusy = false
            status = "本机语音聊天协调器不可用。"
            onDiagnostic?("speech.capture.coordinator-unavailable")
            return
        }
        var recognizedTranscript: String?
        onVoiceChat(url, settings, { [weak self] text in
            recognizedTranscript = text
            self?.onDiagnostic?("speech.asr.transcribed characters=\(text.count)")
            DispatchQueue.main.async { self?.status = "识别到：\(text)" }
        }) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.voiceTurnBusy = false
                let transcriptPrefix = recognizedTranscript.map { text in
                    "识别到：\(text.prefix(160))\(text.count > 160 ? "…" : "")；"
                } ?? ""
                switch result {
                case .success(let message):
                    self.status = transcriptPrefix + message
                    self.onDiagnostic?("speech.capture.finished result=success")
                case .failure(let error):
                    self.status = transcriptPrefix + error.localizedDescription
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
}

private struct SpeechSettingsPage: View {
    @ObservedObject var model: SpeechSettingsWindow

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.page == .voice { voicePage } else { livePage }
                }
                .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 18)
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            Divider()
            HStack(spacing: 12) {
                Text(model.status).font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("speech-settings-status")
                Button("保存", action: model.saveSettings)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(WorkspaceActionButtonStyle(prominent: true))
                    .disabled(model.offlinePreview)
            }
            .padding(.horizontal, 18).padding(.vertical, 10)
        }
        .background(Color(nsColor: WorkspacePalette.canvas))
        .tint(Color(nsColor: WorkspacePalette.accent))
    }

    private var voicePage: some View {
        Group {
            WorkspaceSectionCard(title: "输入来源") {
                VStack(alignment: .leading, spacing: 12) {
                    field("麦克风") {
                        HStack(spacing: 8) {
                            Picker("麦克风", selection: Binding(get: { model.microphoneUID }, set: model.microphoneChanged)) {
                                if model.microphoneChoices.isEmpty {
                                    Text("未发现麦克风").tag(Optional<String>.none)
                                }
                                ForEach(model.microphoneChoices) { device in Text(device.name).tag(Optional(device.id)) }
                            }
                            .labelsHidden().frame(maxWidth: .infinity)
                            .disabled(!model.microphoneAvailable || model.microphoneTesting || model.recording || model.voiceTurnBusy)
                            Button(model.microphoneTesting ? "检测中…" : "检测麦克风", action: model.testMicrophone)
                                .disabled(model.offlinePreview || !model.microphoneAvailable || model.microphoneTesting || model.recording || model.voiceTurnBusy)
                            ProgressView(value: model.microphoneLevel).frame(width: 84)
                                .accessibilityLabel("麦克风输入电平")
                        }
                    }
                    field("参考音频") {
                        HStack {
                            Label(model.referenceAudioPath.isEmpty ? "未选择" : URL(fileURLWithPath: model.referenceAudioPath).lastPathComponent,
                                  systemImage: "waveform")
                                .foregroundStyle(model.referenceAudioPath.isEmpty ? Color.secondary : Color.primary)
                                .lineLimit(1).help(model.referenceAudioPath)
                            Spacer(minLength: 8)
                            Button("选择参考音频…", action: model.chooseReferenceAudio)
                            Button("移除", action: model.removeReferenceAudio).disabled(model.referenceAudioPath.isEmpty)
                        }
                    }
                    field("准确转写") {
                        TextField("参考音频的准确逐字转写（必填）", text: $model.referenceTranscript)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }
            WorkspaceSectionCard(title: "回复与互动") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("在桌宠气泡中显示生成的回复", isOn: $model.displayReplies)
                    Toggle("朗读生成的回复（播放到扬声器）", isOn: $model.speakReplies)
                    Toggle("朗读桌宠互动气泡", isOn: $model.speakInteractiveBubbles)
                    HStack(spacing: 8) {
                        Button(model.recording ? "停止并发送" : "开始语音聊天", action: model.toggleVoiceChat)
                            .disabled(model.offlinePreview || !model.microphoneAvailable || model.voiceTurnBusy || model.microphoneTesting)
                            .buttonStyle(WorkspaceActionButtonStyle(prominent: true))
                        Button(model.demoBusy ? "正在运行…" : "运行在线模型演示", action: model.runDemo)
                            .disabled(model.offlinePreview || model.demoBusy || model.voiceTurnBusy || model.microphoneTesting)
                    }
                    Text("API Key 在“模型管理”中单独保存至 macOS 钥匙串；语音设置、诊断日志和本地运行参数不保存 API Key。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var livePage: some View {
        Group {
            WorkspaceSectionCard(title: "接入状态") {
                Label("平台连接暂不可用", systemImage: "info.circle.fill")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(.orange)
                Text("平台授权、弹幕接收和互动发送尚未实现。当前页面仅保存平台与房间标识。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            WorkspaceSectionCard(title: "房间配置") {
                VStack(alignment: .leading, spacing: 12) {
                    field("平台") {
                        Picker("平台", selection: $model.platform) {
                            Text("B站（接入开发中）").tag("bilibili")
                            Text("抖音（接入待评估）").tag("douyin")
                        }
                        .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                    }
                    field("房间号") {
                        TextField("直播间号或房间标识", text: $model.roomIdentifier)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }
        }
    }

    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            content()
        }
    }
}
