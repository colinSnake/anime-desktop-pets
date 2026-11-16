import Foundation

/// User-facing names are independent of persistent instance/package identities.
public enum PetPresentation {
    public static func name(id: String, displayName: String? = nil) -> String {
        if id == "white-dragon" { return "龙妹" }
        if id.range(of: #"^white-dragon(?:-copy(?:-[0-9]+)?)+$"#, options: .regularExpression) != nil {
            let suffix = String(id.dropFirst("white-dragon".count))
                .replacingOccurrences(of: "-copy", with: "·分身")
            return "龙妹" + suffix
        }
        return displayName ?? id
    }

    public static func phase(_ phase: PetInstancePhase) -> String {
        switch phase {
        case .stopped: return "已停止"
        case .starting: return "启动中"
        case .running: return "运行中"
        case .stopping: return "停止中"
        case .failed: return "异常"
        }
    }

    public static func menuTitle(_ row: PetInstanceControlRow) -> String {
        let error = row.error.map { " · \($0.prefix(48))" } ?? ""
        return "\(name(id: row.id, displayName: row.displayName)) · \(phase(row.phase))\(error)"
    }
}
