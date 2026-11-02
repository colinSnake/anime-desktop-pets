import Darwin
import Foundation

public enum PetInstanceCommand: String, Codable, Sendable {
    case status, startPet = "start_pet", startSelected = "start_selected", stopPet = "stop_pet"
    case stopAll = "stop_all", setPreferences = "set_preferences", clonePet = "clone_pet", shutdown
    case setPackage = "set_package"
}

public struct PetPreferencePatch: Codable, Sendable {
    public var size: Int?
    public var x: Double?
    public var y: Double?
    public var scheduledActivity: Bool?
    public var movement: Bool?
    public var hideInFullscreen: Bool?
    public init(size: Int? = nil, x: Double? = nil, y: Double? = nil,
                scheduledActivity: Bool? = nil, movement: Bool? = nil, hideInFullscreen: Bool? = nil) {
        self.size = size; self.x = x; self.y = y; self.scheduledActivity = scheduledActivity
        self.movement = movement; self.hideInFullscreen = hideInFullscreen
    }
    public func validate() throws {
        guard size.map({ (128...384).contains($0) }) ?? true,
              [x, y].compactMap({ $0 }).allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else {
            throw ConfigurationError("实例偏好补丁无效")
        }
    }
}

public struct PetInstanceControlRequest: Codable, Sendable {
    public let protocolVersion: Int
    public let requestId: String
    public let command: PetInstanceCommand
    public let instanceID: String?
    public let cloneID: String?
    public let instanceIDs: [String]?
    public let preferences: PetPreferencePatch?
    public let package: PetPackageReference?
    public init(_ command: PetInstanceCommand, requestId: String = UUID().uuidString,
                instanceID: String? = nil, cloneID: String? = nil, instanceIDs: [String]? = nil,
                preferences: PetPreferencePatch? = nil, package: PetPackageReference? = nil) {
        self.protocolVersion = 1; self.requestId = requestId; self.command = command
        self.instanceID = instanceID; self.cloneID = cloneID; self.instanceIDs = instanceIDs; self.preferences = preferences
        self.package = package
    }
    public func validate() throws {
        func identifier(_ value: String) -> Bool {
            value.count <= 64 && value.range(of: #"\A[a-z0-9]+(?:-[a-z0-9]+)*\z"#, options: .regularExpression) != nil
        }
        guard protocolVersion == 1, requestId.range(of: #"\A[A-Za-z0-9_-]{1,64}\z"#, options: .regularExpression) != nil else {
            throw ConfigurationError("控制协议或requestId无效")
        }
        switch command {
        case .status, .stopAll, .shutdown:
            guard instanceID == nil, cloneID == nil, instanceIDs == nil, preferences == nil, package == nil else { throw ConfigurationError("命令包含多余参数") }
        case .startPet, .stopPet, .setPreferences:
            guard let id = instanceID, identifier(id), cloneID == nil, instanceIDs == nil,
                  (command == .setPreferences) == (preferences != nil), package == nil else { throw ConfigurationError("单实例命令参数无效") }
        case .setPackage:
            guard let id = instanceID, identifier(id), package != nil, cloneID == nil, instanceIDs == nil,
                  preferences == nil else { throw ConfigurationError("素材包切换参数无效") }
        case .startSelected:
            guard let ids = instanceIDs, (1...32).contains(ids.count), Set(ids).count == ids.count,
                  ids.allSatisfy(identifier), instanceID == nil, cloneID == nil, preferences == nil, package == nil else { throw ConfigurationError("批量命令参数无效") }
        case .clonePet:
            guard let sourceID = instanceID, identifier(sourceID), let newID = cloneID,
                  identifier(newID), sourceID != newID, instanceIDs == nil, preferences == nil, package == nil else {
                throw ConfigurationError("小分身命令参数无效")
            }
        }
        try preferences?.validate()
    }
    public func encoded() throws -> Data {
        try validate()
        var data = try JSONEncoder().encode(self); data.append(10)
        guard data.count <= 8192 else { throw ConfigurationError("控制请求过大") }
        return data
    }
}

public struct PetInstanceControlStatus: Codable, Sendable {
    public let shuttingDown: Bool
    public let maximumRunning: Int
    public let instances: [PetInstanceControlRow]
}
public struct PetInstanceControlRow: Codable, Sendable {
    public let id: String
    public let package: PetPackageReference
    public let enabled: Bool
    public let preferences: PetInstancePreferences
    public let phase: PetInstancePhase
    public let error: String?
    public init(id: String, package: PetPackageReference, enabled: Bool,
                preferences: PetInstancePreferences, phase: PetInstancePhase,
                error: String? = nil) {
        self.id = id; self.package = package; self.enabled = enabled
        self.preferences = preferences; self.phase = phase; self.error = error
    }
}
public struct PetInstanceControlOutcome: Codable, Sendable {
    public let instanceID: String
    public let accepted: Bool
    public let changed: Bool
    public let error: String?
}
public struct PetInstanceControlResult: Codable, Sendable {
    public let controllerPID: Int32
    public let status: PetInstanceControlStatus
    public let outcomes: [PetInstanceControlOutcome]
}
public struct PetInstanceControlFailure: Codable, Sendable {
    public let code: String
    public let message: String
}
public struct PetInstanceControlReply: Codable, Sendable {
    public let protocolVersion: Int
    public let requestId: String
    public let ok: Bool
    public let result: PetInstanceControlResult?
    public let error: PetInstanceControlFailure?
    public static func decode(_ data: Data, for request: PetInstanceControlRequest) throws -> Self {
        let reply = try JSONDecoder().decode(Self.self, from: data)
        guard reply.protocolVersion == 1, reply.requestId == request.requestId,
              (reply.ok && reply.result != nil && reply.error == nil) || (!reply.ok && reply.error != nil && reply.result == nil) else {
            throw ConfigurationError("控制响应关联、版本或结果无效")
        }
        if let result = reply.result {
            guard result.controllerPID > 0, (1...8).contains(result.status.maximumRunning), result.status.instances.count <= 32,
                  Set(result.status.instances.map(\.id)).count == result.status.instances.count else { throw ConfigurationError("控制状态数量无效") }
            for row in result.status.instances {
                _ = try PetInstanceDefinition(id: row.id, package: row.package, enabled: row.enabled, preferences: row.preferences)
            }
        }
        return reply
    }
}

public enum PetInstanceTransportError: LocalizedError {
    case unavailable(String), uncertain(String)
    public var errorDescription: String? {
        switch self {
        case .unavailable(let message): return "多宠控制器不可用：" + message
        case .uncertain(let message): return "命令已发送但结果不确定，不会自动重放或启动第二控制器：" + message
        }
    }
}

/// 同步、有总截止时间的本地传输。UI调用方应放在非主线程；不启动helper、不重试。
public enum PetInstanceControlClient {
    public static func send(_ request: PetInstanceControlRequest, directory: URL, timeout: TimeInterval = 2) throws -> PetInstanceControlReply {
        let payload = try request.encoded()
        guard timeout.isFinite, (0.05...10).contains(timeout) else { throw ConfigurationError("控制超时范围无效") }
        let manager = FileManager.default
        func check(_ url: URL, type: FileAttributeType, mode: Int) throws {
            let attributes = try manager.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == type,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  (attributes[.posixPermissions] as? NSNumber)?.intValue == mode else {
                throw PetInstanceTransportError.unavailable("路径类型、所有者或权限无效")
            }
        }
        do { try check(directory, type: .typeDirectory, mode: 0o700) }
        catch { throw PetInstanceTransportError.unavailable(error.localizedDescription) }
        let url = directory.appendingPathComponent("pet-control.sock")
        do { try check(url, type: .typeSocket, mode: 0o600) }
        catch { throw PetInstanceTransportError.unavailable(error.localizedDescription) }
        var address = sockaddr_un()
        let path = Array(url.path.utf8) + [UInt8(0)]
        guard path.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw PetInstanceTransportError.unavailable("控制路径过长") }
        address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: path + Array(repeating: UInt8(0), count: buffer.count - path.count))
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw PetInstanceTransportError.unavailable("无法创建本地连接") }
        defer { Darwin.close(fd) }
        guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else { throw PetInstanceTransportError.unavailable("无法设置非阻塞连接") }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var one: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw PetInstanceTransportError.unavailable("无法配置连接")
        }
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var sent = false
        func failure(_ message: String) -> PetInstanceTransportError {
            sent ? .uncertain(message) : .unavailable(message)
        }
        func wait(_ events: Int16) throws {
            while true {
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { throw failure("等待确认超时") }
                var descriptor = pollfd(fd: fd, events: events, revents: 0)
                let result = poll(&descriptor, 1, Int32(min(10_000, ceil(remaining * 1000))))
                if result > 0 { return }
                if result == 0 { throw failure("等待确认超时") }
                if errno != EINTR { throw failure("本地连接等待失败") }
            }
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if connected != 0 {
            guard errno == EINPROGRESS || errno == EWOULDBLOCK else { throw failure("无法连接现有控制器") }
            try wait(Int16(POLLOUT))
            var error: Int32 = 0; var length = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0, error == 0 else { throw failure("连接未建立") }
        }
        var offset = 0
        while offset < payload.count {
            try wait(Int16(POLLOUT))
            let count = payload.withUnsafeBytes { bytes in Darwin.send(fd, bytes.baseAddress!.advanced(by: offset), payload.count - offset, 0) }
            if count > 0 { offset += count; sent = true }
            else if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
            else { throw failure("发送未完成") }
        }
        var received = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            try wait(Int16(POLLIN))
            let count = Darwin.recv(fd, &buffer, buffer.count, 0)
            if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
            guard count > 0 else { throw failure("收到确认前断开") }
            received.append(contentsOf: buffer.prefix(count))
            guard received.count <= 128 * 1024 else { throw failure("控制响应过大") }
            if let newline = received.firstIndex(of: 10) {
                guard newline == received.index(before: received.endIndex) else { throw failure("控制响应含额外数据") }
                do { return try PetInstanceControlReply.decode(Data(received[..<newline]), for: request) }
                catch { throw failure("确认无效：" + error.localizedDescription) }
            }
        }
    }
}
