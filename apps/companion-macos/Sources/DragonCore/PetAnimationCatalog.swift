import Foundation

/// 只验证完整桌宠的动作目录，不解码或执行第三方代码。
public struct PetAnimationCatalog: Equatable, Sendable {
    public let idleCount: Int
    public let interactionCount: Int
    public let workCount: Int
    public let movementCount: Int
    public let specialCount: Int
    public var actionCount: Int { idleCount + interactionCount + workCount + specialCount + movementCount }

    public static func inspect(root: URL) throws -> Self {
        let root = root.resolvingSymlinksInPath().standardizedFileURL
        let manifestURL = root.appendingPathComponent("素材清单.json")
        let size = try manifestURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= 1024 * 1024 else { throw ConfigurationError("动作清单超过大小限制") }
        let data = try Data(contentsOf: manifestURL)
        guard data.count <= 1024 * 1024,
              let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let idle = manifest["idle"] as? [String: Any],
              let extra = manifest["additionalIdleAnimations"] as? [[String: Any]],
              let variants = manifest["variants"] as? [[String: Any]],
              let workSlots = manifest["workAnimations"] as? [Any] else {
            throw ConfigurationError("完整桌宠动作清单无效")
        }
        let work = workSlots.compactMap { $0 as? [String: Any] }
        let special = ["dragAnimation", "landingAnimation", "quotaAnimation"].compactMap { manifest[$0] as? [String: Any] }
        let movement = manifest["movementAnimations"] as? [[String: Any]] ?? []
        let result = Self(idleCount: 1 + extra.count, interactionCount: variants.count,
                          workCount: work.count, movementCount: movement.count, specialCount: special.count)
        guard ((result.idleCount == 2 && movement.isEmpty) || (result.idleCount == 6 && movement.count == 6)), result.interactionCount == 15,
              result.workCount == 5, result.specialCount == 3 else {
            throw ConfigurationError("完整桌宠应为原版25动作或增强版35动作（含6待机和6移动）")
        }
        func validate(_ item: [String: Any], allowTransition: Bool) throws {
            guard let source = item["playbackFile"] as? String ?? item["file"] as? String,
                  !source.isEmpty, !source.hasPrefix("/"),
                  let duration = item["durationMs"] as? NSNumber,
                  duration.doubleValue.isFinite, duration.doubleValue > 0 else {
                throw ConfigurationError("动作路径或时长无效")
            }
            let relative = item["playbackFile"] == nil ? source.replacingOccurrences(of: ".webm", with: ".webp") : source
            let url = root.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
            guard url.path.hasPrefix(root.path + "/"),
                  let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
                  attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = attributes[.size] as? NSNumber, size.int64Value > 0 else {
                throw ConfigurationError("动作播放文件缺失或超出素材目录：\(relative)")
            }
            if let transition = item["returnTransition"] as? [String: Any] {
                guard allowTransition else { throw ConfigurationError("不支持嵌套动作过渡") }
                try validate(transition, allowTransition: false)
            }
        }
        let items = [idle] + extra + variants + work + special + movement
        let identifiers = items.compactMap { $0["id"] as? String }
        guard identifiers.count == items.count, Set(identifiers).count == items.count else {
            throw ConfigurationError("动作标识缺失或重复")
        }
        for item in movement {
            guard let start = item["moveStartMs"] as? Double, let stop = item["moveStopMs"] as? Double,
                  let duration = item["durationMs"] as? Double, start.isFinite, stop.isFinite,
                  start >= 0, start < stop, stop <= duration,
                  ["left", "right"].contains(item["sourceFacing"] as? String ?? "") else {
                throw ConfigurationError("移动动作时段或朝向无效")
            }
        }
        for item in items { try validate(item, allowTransition: true) }
        return result
    }
}

/// 只表示伴侣当前的显示意图，不读取外部桌宠的聊天或任务状态。
public struct ExternalPetLaunchIntent: Sendable {
    public enum Resolution: Equatable { case reveal, leaveAlone, hide }
    public private(set) var generation = 0
    public private(set) var wantsVisible = false
    public init() {}
    public mutating func show() -> Int { generation += 1; wantsVisible = true; return generation }
    public mutating func hide() { generation += 1; wantsVisible = false }
    public func resolve(_ token: Int) -> Resolution {
        if !wantsVisible { return .hide }
        return token == generation ? .reveal : .leaveAlone
    }
}
