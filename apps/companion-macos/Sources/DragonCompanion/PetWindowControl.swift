import Foundation
import DragonCore
import Darwin

/// Window-level control for our enhanced helper only. Call off the main thread.
/// A fixed, user-owned socket and matching PID are required; never retries a mutation.
enum PetWindowControl {
    struct Reply: Decodable, Sendable {
        let ok: Bool
        let pid: Int32
        let visible: Bool
        let hidden: Bool
        let preferences: PetInstancePreferences?
    }

    static func send(_ command: String, pid: Int32, directory: URL = FileManager.default.temporaryDirectory) throws -> Reply {
        guard ["show", "hide", "status", "quit"].contains(command), pid > 0 else {
            throw ConfigurationError("窗口控制请求无效")
        }
        let url = directory.appendingPathComponent("dragon-pet-\(getuid())-\(pid).sock")
        let info = try FileManager.default.attributesOfItem(atPath: url.path)
        guard info[.type] as? FileAttributeType == .typeSocket,
              (info[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (info[.posixPermissions] as? NSNumber)?.intValue == 0o600 else {
            throw ConfigurationError("桌宠窗口控制路径无效")
        }
        let path = Array(url.path.utf8) + [UInt8(0)]
        var address = sockaddr_un()
        guard path.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw ConfigurationError("窗口控制路径过长") }
        address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path + Array(repeating: UInt8(0), count: $0.count - path.count)) }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ConfigurationError("无法创建窗口控制连接") }
        defer { Darwin.close(fd) }
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        var one: Int32 = 1
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        guard setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw ConfigurationError("无法配置窗口控制超时")
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw ConfigurationError("桌宠窗口控制通道未就绪") }
        var payload = try JSONSerialization.data(withJSONObject: ["command": command, "pid": pid])
        payload.append(10)
        let sent = payload.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
        guard sent == payload.count else { throw ConfigurationError("桌宠窗口请求未确认；未自动重试") }
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 512)
        while data.count <= 512 && ProcessInfo.processInfo.systemUptime < deadline {
            let count = Darwin.recv(fd, &bytes, bytes.count, 0)
            guard count > 0 else { break }
            data.append(contentsOf: bytes.prefix(count))
            guard data.count <= 512 else { throw ConfigurationError("桌宠窗口确认超过大小限制") }
            if data.last == 10 {
                let reply = try JSONDecoder().decode(Reply.self, from: data)
                guard reply.ok, reply.pid == pid else { throw ConfigurationError("桌宠窗口确认身份不匹配") }
                try reply.preferences?.validate()
                return reply
            }
        }
        throw ConfigurationError("桌宠窗口请求未确认；未自动重试")
    }
}
