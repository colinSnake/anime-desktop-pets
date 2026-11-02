import Darwin
import DragonCore
import Foundation

// flock is a libc function as well as a Darwin struct name.
@_silgen_name("flock") private func systemFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

final class InstanceLock {
    private let fd: Int32
    init(url: URL) throws {
        fd = Darwin.open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ConfigurationError("无法打开实例锁") }
        guard systemFlock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd)
            throw ConfigurationError("\(AppCopy.name)已经在运行了；用 --status 查看状态，或用 --show 显示桌宠")
        }
    }
    deinit { _ = systemFlock(fd, LOCK_UN); Darwin.close(fd) }
}

private func socketAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw ConfigurationError("本机控制 Socket 路径过长，请缩短 DRAGON_DATA_DIR")
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: bytes) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
}

private func withAddress<T>(_ address: inout sockaddr_un, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
    withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
}

private func configureTimeout(_ fd: Int32) {
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    withUnsafePointer(to: &timeout) {
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, $0, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, $0, socklen_t(MemoryLayout<timeval>.size))
    }
    var noSignal: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
}

private func writeAll(_ data: Data, to fd: Int32) throws {
    try data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        while offset < raw.count {
            let n = Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw ConfigurationError("本机控制连接写入失败：\(String(cString: strerror(errno)))") }
            offset += n
        }
    }
}

private func readLine(_ fd: Int32, limit: Int = 8192) throws -> Data {
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while result.count < limit {
        let n = Darwin.read(fd, &buffer, min(buffer.count, limit - result.count))
        if n < 0 && errno == EINTR { continue }
        guard n > 0 else { throw ConfigurationError("本机控制连接无响应") }
        result.append(contentsOf: buffer.prefix(n))
        if let end = result.firstIndex(of: 10) { return result.prefix(upTo: end) }
    }
    throw ConfigurationError("控制消息超出长度限制")
}

final class ControlSocket {
    private let queue = DispatchQueue(label: "local.dragon.control", qos: .utility)
    private var source: DispatchSourceRead?
    private var fd: Int32 = -1
    private let path: String
    private let handler: @MainActor (ControlRequest) -> CompanionStatus

    init(url: URL, handler: @escaping @MainActor (ControlRequest) -> CompanionStatus) throws {
        self.path = url.path; self.handler = handler
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ConfigurationError("无法创建本机控制 Socket") }
        do {
            // Caller owns the process lock before removing a stale socket.
            if FileManager.default.fileExists(atPath: path) {
                let attrs = try FileManager.default.attributesOfItem(atPath: path)
                guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(), attrs[.type] as? FileAttributeType == .typeSocket else {
                    throw ConfigurationError("拒绝替换不属于当前用户的 Socket 或非 Socket 文件")
                }
                try FileManager.default.removeItem(atPath: path)
            }
            var address = try socketAddress(path)
            guard withAddress(&address, { Darwin.bind(fd, $0, $1) }) == 0 else { throw ConfigurationError("控制 Socket 绑定失败") }
            guard chmod(path, 0o600) == 0, Darwin.listen(fd, 8) == 0 else { throw ConfigurationError("控制 Socket 监听失败") }
            _ = fcntl(fd, F_SETFL, O_NONBLOCK)
            let listener = fd
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in
                let client = Darwin.accept(listener, nil, nil)
                guard client >= 0 else { return }
                guard let self else { Darwin.close(client); return }
                // On macOS accept inherits O_NONBLOCK. Restore blocking mode so a request
                // arriving just after accept isn't mistaken for a disconnected client.
                let flags = fcntl(client, F_GETFL)
                _ = fcntl(client, F_SETFL, flags & ~O_NONBLOCK)
                configureTimeout(client)
                do {
                    let request = try JSONDecoder().decode(ControlRequest.self, from: readLine(client))
                    Task { @MainActor [weak self] in
                        guard let self else { Darwin.close(client); return }
                        let response = self.handler(request)
                        self.queue.async {
                            defer { Darwin.close(client) }
                            if var data = try? JSONEncoder().encode(response) { data.append(10); try? writeAll(data, to: client) }
                        }
                    }
                } catch { Darwin.close(client) }
            }
            // Close only when GCD has retired the source, avoiding an fd-reuse race.
            source.setCancelHandler { Darwin.close(listener) }
            self.source = source
            source.resume()
        } catch { Darwin.close(fd); fd = -1; throw error }
    }
    deinit {
        source?.cancel()
        if source != nil { try? FileManager.default.removeItem(atPath: path) }
    }
    static func request(_ command: ControlCommand, at url: URL) throws -> CompanionStatus {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ConfigurationError("无法创建控制连接") }
        defer { Darwin.close(fd) }
        configureTimeout(fd)
        var address = try socketAddress(url.path)
        guard withAddress(&address, { Darwin.connect(fd, $0, $1) }) == 0 else { throw ConfigurationError("\(AppCopy.name)还没启动，先打开 App 再试试吧") }
        var data = try JSONEncoder().encode(ControlRequest(command)); data.append(10)
        try writeAll(data, to: fd)
        return try JSONDecoder().decode(CompanionStatus.self, from: readLine(fd))
    }
}
