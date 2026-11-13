import CharacterUI

enum WorkspaceSection: String, CaseIterable {
    case pets = "桌宠"
    case characterChat = "聊天"
    case character = "身份"
    case characterMemories = "记忆"
    case characterCapabilities = "能力"
    case models = "模型管理"
    case speech = "语音互动"
    case live = "直播管理"
    case advanced = "高级"

    var symbol: String {
        switch self {
        case .pets: "pawprint.fill"
        case .characterChat: "bubble.left.and.bubble.right"
        case .character: "person.text.rectangle"
        case .characterMemories: "brain.head.profile"
        case .characterCapabilities: "bolt.badge.clock"
        case .models: "cpu"
        case .speech: "waveform"
        case .live: "dot.radiowaves.left.and.right"
        case .advanced: "slider.horizontal.3"
        }
    }

    var subtitle: String {
        switch self {
        case .pets: "实例、运行状态与桌宠控制"
        case .characterChat: "与龙妹进行本地或在线对话"
        case .character: "身份设定与角色资料"
        case .characterMemories: "本地记忆与知识资料"
        case .characterCapabilities: "可用能力与权限边界"
        case .models: "服务商、模型与连接"
        case .speech: "语音聊天、麦克风与桌宠语音"
        case .live: "平台与房间配置；直播接入尚未完成"
        case .advanced: "数据位置与系统权限"
        }
    }

    var isCharacterPage: Bool {
        switch self {
        case .characterChat, .character, .characterMemories, .characterCapabilities: true
        default: false
        }
    }

    var characterPage: CharacterWorkspacePage {
        switch self {
        case .characterChat: .chat
        case .character: .identity
        case .characterMemories: .memories
        case .characterCapabilities: .capabilities
        default: .identity
        }
    }
}
