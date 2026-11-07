import Foundation

public enum PetBuildIdentity {
    public static func supports(buildVersion: String?, patchVersion: String?, metadata: [String: Any]) -> Bool {
        guard let buildVersion, let patchVersion, patchVersion.range(of: #"^dragon\.[0-9]+$"#, options: .regularExpression) != nil else {
            return false
        }
        return metadata["patchVersion"] as? String == patchVersion &&
            metadata["upstreamVersion"] as? String == "0.4.1-mac.3" &&
            metadata["bundleVersion"] as? String == buildVersion
    }
}

/// 素材与实例分离；不包含账号、对话或任意可执行路径。
public struct PetPackageReference: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let version: String
    public init(id: String, version: String) throws {
        self.id = id; self.version = version
        try validate()
    }
    public func validate() throws {
        guard id.count <= 100, id.range(of: #"^[a-z0-9]+(?:[.-][a-z0-9]+)*$"#, options: .regularExpression) != nil,
              version.count <= 64, version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$"#, options: .regularExpression) != nil else {
            throw ConfigurationError("宠物包身份无效")
        }
    }
}

public struct PetInstancePreferences: Codable, Equatable, Sendable {
    public var size: Int
    public var x: Double?
    public var y: Double?
    public var scheduledActivity: Bool
    public var movement: Bool
    public var hideInFullscreen: Bool
    public init(size: Int = 256, x: Double? = nil, y: Double? = nil,
                scheduledActivity: Bool = true, movement: Bool = true, hideInFullscreen: Bool = true) {
        self.size = size; self.x = x; self.y = y
        self.scheduledActivity = scheduledActivity; self.movement = movement; self.hideInFullscreen = hideInFullscreen
    }
    public func validate() throws {
        guard (128...384).contains(size), (x == nil) == (y == nil),
              [x, y].compactMap({ $0 }).allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else {
            throw ConfigurationError("实例尺寸或位置无效")
        }
    }
}

public struct PetInstanceDefinition: Codable, Equatable, Sendable {
    public let id: String
    public let package: PetPackageReference
    public let displayName: String?
    public var enabled: Bool
    public var autoStartOnLaunch: Bool
    public var preferences: PetInstancePreferences
    public init(id: String, package: PetPackageReference, enabled: Bool = true, autoStartOnLaunch: Bool = true,
                preferences: PetInstancePreferences = .init(), displayName: String? = nil) throws {
        self.id = id; self.package = package; self.displayName = displayName; self.enabled = enabled
        self.autoStartOnLaunch = autoStartOnLaunch; self.preferences = preferences
        try validate()
    }
    private enum CodingKeys: String, CodingKey { case id, package, displayName, enabled, autoStartOnLaunch, preferences }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        package = try values.decode(PetPackageReference.self, forKey: .package)
        displayName = try values.decodeIfPresent(String.self, forKey: .displayName)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        autoStartOnLaunch = try values.decodeIfPresent(Bool.self, forKey: .autoStartOnLaunch)
            ?? !Self.isLegacyCloneID(id)
        preferences = try values.decodeIfPresent(PetInstancePreferences.self, forKey: .preferences) ?? .init()
        try validate(allowLegacySize: true)
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id); try values.encode(package, forKey: .package)
        try values.encodeIfPresent(displayName, forKey: .displayName)
        try values.encode(enabled, forKey: .enabled); try values.encode(autoStartOnLaunch, forKey: .autoStartOnLaunch)
        try values.encode(preferences, forKey: .preferences)
    }
    private static func isLegacyCloneID(_ id: String) -> Bool {
        id.range(of: #"(?:-copy(?:-[0-9]+)?)+$"#, options: .regularExpression) != nil
    }
    public func validate() throws {
        try validate(allowLegacySize: false)
    }
    private func validate(allowLegacySize: Bool) throws {
        guard id.count <= 64, id.range(of: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) != nil else {
            throw ConfigurationError("实例ID无效")
        }
        try package.validate()
        if let displayName {
            guard !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, displayName.count <= 80,
                  !displayName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                throw ConfigurationError("桌宠名称无效")
            }
        }
        if allowLegacySize {
            guard (96...512).contains(preferences.size) else { throw ConfigurationError("实例尺寸无效") }
            var coordinates = preferences
            coordinates.size = 256
            try coordinates.validate()
        } else {
            try preferences.validate()
        }
    }
}

public struct PetInstanceRegistry: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public var instances: [PetInstanceDefinition]
    public init(instances: [PetInstanceDefinition] = []) throws {
        schemaVersion = 1; self.instances = instances; try validate()
    }
    public func validate() throws {
        guard schemaVersion == 1, instances.count <= 32,
              Set(instances.map(\.id)).count == instances.count else {
            throw ConfigurationError("实例清单版本、数量或身份冲突")
        }
        for instance in instances { try instance.validate() }
    }
    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= 128 * 1024 else { throw ConfigurationError("实例清单过大") }
        var result = try JSONDecoder().decode(Self.self, from: data)
        for index in result.instances.indices {
            let size = result.instances[index].preferences.size
            guard (96...512).contains(size) else { throw ConfigurationError("实例尺寸无效") }
            result.instances[index].preferences.size = min(384, max(128, size))
        }
        try result.validate(); return result
    }
}

public enum PetInstancePhase: String, Codable, Sendable {
    case stopped, starting, running, stopping, failed
}

public struct PetInstanceTicket: Equatable, Sendable {
    public let instanceID: String
    public let generation: UUID
}

public struct PetInstanceState: Equatable, Sendable {
    public fileprivate(set) var phase: PetInstancePhase = .stopped
    public fileprivate(set) var generation = UUID()
    public fileprivate(set) var error: String?
}

/// 宿主侧纯状态模型；所有异步回调必须携带ticket，不持有或启动真实进程。
public struct PetInstanceLifecycle: Sendable {
    public let registry: PetInstanceRegistry
    public let maximumRunning: Int
    public private(set) var states: [String: PetInstanceState]
    public private(set) var shuttingDown = false
    public init(registry: PetInstanceRegistry, maximumRunning: Int = 3) throws {
        try registry.validate()
        guard (1...8).contains(maximumRunning) else { throw ConfigurationError("同时运行数量无效") }
        self.registry = registry; self.maximumRunning = maximumRunning
        states = Dictionary(uniqueKeysWithValues: registry.instances.map { ($0.id, PetInstanceState()) })
    }
    public mutating func start(_ id: String) throws -> PetInstanceTicket? {
        guard !shuttingDown else { throw ConfigurationError("控制器正在退出") }
        guard let definition = registry.instances.first(where: { $0.id == id }), let state = states[id] else {
            throw ConfigurationError("实例不存在")
        }
        guard definition.enabled else { throw ConfigurationError("实例已禁用") }
        if state.phase == .running || state.phase == .starting { return nil }
        guard state.phase != .stopping else { throw ConfigurationError("实例正在停止") }
        guard states.values.filter({ [.starting, .running, .stopping].contains($0.phase) }).count < maximumRunning else {
            throw ConfigurationError("同时运行数量已达上限")
        }
        let ticket = PetInstanceTicket(instanceID: id, generation: UUID())
        states[id] = PetInstanceState(phase: .starting, generation: ticket.generation, error: nil)
        return ticket
    }
    @discardableResult public mutating func ready(_ ticket: PetInstanceTicket) -> Bool {
        guard states[ticket.instanceID]?.generation == ticket.generation,
              states[ticket.instanceID]?.phase == .starting else { return false }
        states[ticket.instanceID]?.phase = .running; return true
    }
    public mutating func stop(_ id: String) throws -> PetInstanceTicket? {
        guard let state = states[id] else { throw ConfigurationError("实例不存在") }
        if state.phase == .stopped || state.phase == .failed { return nil }
        if state.phase == .stopping { return nil }
        let ticket = PetInstanceTicket(instanceID: id, generation: UUID())
        states[id] = PetInstanceState(phase: .stopping, generation: ticket.generation, error: nil)
        return ticket
    }
    @discardableResult public mutating func stopped(_ ticket: PetInstanceTicket) -> Bool {
        guard states[ticket.instanceID]?.generation == ticket.generation,
              states[ticket.instanceID]?.phase == .stopping else { return false }
        let finalPhase: PetInstancePhase = states[ticket.instanceID]?.error == nil ? .stopped : .failed
        states[ticket.instanceID]?.phase = finalPhase
        return true
    }
    /// 错误后先进入stopping；只有清理确认才能释放运行名额。
    public mutating func failed(_ ticket: PetInstanceTicket, message: String) -> PetInstanceTicket? {
        guard states[ticket.instanceID]?.generation == ticket.generation,
              let phase = states[ticket.instanceID]?.phase, [.starting, .running].contains(phase) else { return nil }
        let cleanup = PetInstanceTicket(instanceID: ticket.instanceID, generation: UUID())
        states[ticket.instanceID] = PetInstanceState(phase: .stopping, generation: cleanup.generation,
                                                    error: String(message.prefix(512)))
        return cleanup
    }
    public mutating func shutdown() -> [PetInstanceTicket] {
        shuttingDown = true
        return registry.instances.compactMap { try? stop($0.id) }
    }
}
