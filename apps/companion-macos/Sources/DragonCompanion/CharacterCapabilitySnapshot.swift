import CharacterCore
import Foundation

enum CharacterCapabilitySnapshot {
    /// No provider configuration, model files or keychain inspection in offline previews.
    static let offlinePreview = [
        CharacterCapability(id: "chat", name: "在线对话", status: .unavailable,
                            detail: "离线预览不会连接在线服务。"),
        CharacterCapability(id: "memory", name: "本地记忆", status: .enabled,
                            detail: "仅写入当前隔离预览目录。"),
    ]

    static func make(runtime: Runtime, speechRuntimeAvailable: Bool) -> [CharacterCapability] {
        let repository = ProcessInfo.processInfo.environment["DRAGON_DEV_ROOT"].map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL
        } ?? runtime.resources.deletingLastPathComponent()
        let models = repository.appendingPathComponent(".local/voice-runtime/models", isDirectory: true)
        let asrReady = speechRuntimeAvailable && FileManager.default.fileExists(
            atPath: models.appendingPathComponent("Qwen3-ASR-0.6B-8bit").path
        )
        let ttsReady = speechRuntimeAvailable && FileManager.default.fileExists(
            atPath: models.appendingPathComponent("Qwen3-TTS-12Hz-0.6B-Base-8bit").path
        )

        let modelSettings = try? ModelProviderStore(stateDirectory: runtime.state).load()
        let keyReady = ModelAPIKeyStore().hasValue()
        let chatReady = modelSettings != nil && keyReady

        return [
            CharacterCapability(id: "asr", name: "本机语音识别", status: asrReady ? .enabled : .unavailable,
                                detail: asrReady ? "语音在本机转写。" : "语音运行时或识别模型未就绪。"),
            CharacterCapability(id: "chat", name: "在线对话", status: chatReady ? .enabled : .needsSetup,
                                detail: chatReady ? "使用模型管理中配置的服务。" : "需要在模型管理中配置服务和钥匙串 Key。"),
            CharacterCapability(id: "tts", name: "本机语音朗读", status: ttsReady ? .enabled : .needsSetup,
                                detail: ttsReady ? "本机 TTS 模型已就绪，可按语音设置启用。" : "本机 TTS 模型或运行时未就绪。"),
            CharacterCapability(id: "pet", name: "桌宠动画", status: runtime.configuration.petBackend == "external" ? .enabled : .unavailable,
                                detail: runtime.configuration.petBackend == "external" ? "由独立桌宠运行时负责显示和动画。" : "当前使用静态桌宠模式。"),
            CharacterCapability(id: "bilibili", name: "B 站直播接入", status: .planned,
                                detail: "尚未接入，不会读取直播间弹幕。"),
            CharacterCapability(id: "douyin", name: "抖音直播接入", status: .planned,
                                detail: "尚未接入，不会读取直播间弹幕。"),
        ]
    }
}
