import AppKit
import DragonCore

/// 页面快照不持有运行时；所有操作由 Coordinator 再次校验后执行。
struct WorkspacePetInstance: Identifiable {
    let id: String
    let name: String
    let phase: PetInstancePhase
    let enabled: Bool
    let isClone: Bool
    let error: String?
    let canControl: Bool
    let canClone: Bool
    let canDelete: Bool
    let cover: PetCoverSource

    var isRunning: Bool { phase == .running }
    var canToggle: Bool { canControl && enabled && phase != .starting && phase != .stopping }
    var status: String {
        if !enabled { return "未启用" }
        switch phase {
        case .running: return "运行中"
        case .starting: return "启动中"
        case .stopping: return "停止中"
        case .stopped: return "已停止"
        case .failed: return "启动失败"
        }
    }
    var statusColor: NSColor {
        switch phase {
        case .running where enabled: return .systemGreen
        case .starting, .stopping: return .systemOrange
        case .failed: return .systemRed
        default: return .secondaryLabelColor
        }
    }
}
