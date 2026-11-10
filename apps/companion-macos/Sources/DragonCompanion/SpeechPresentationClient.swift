import Darwin
import Foundation

enum SpeechPresentationClient {
    enum ClientError: LocalizedError {
        case unavailable
        case rejected(String)
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .unavailable: "增强桌宠呈现通道未就绪；请确认龙妹已由新版 helper 启动。"
            case .rejected(let reason): reason == "pet_busy" ? "龙妹正在处理其他动作或气泡，本次演示未覆盖。" : "桌宠拒绝了回复呈现。"
            case .invalidResponse: "桌宠呈现通道返回无效响应。"
            }
        }
    }

    static func isAvailable(directory: URL) -> Bool {
        guard let info = socketInfo(directory: directory) else { return false }
        return info.st_uid == getuid() && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) &&
            info.st_mode & 0o777 == 0o600
    }

    static func displayReplyAsync(_ text: String, directory: URL) async throws {
        try await Task.detached(priority: .userInitiated) {
            try displayReply(text, directory: directory)
        }.value
    }

    static func displayReply(_ text: String, directory: URL) throws {
        guard text.utf8.count <= 512, !text.isEmpty,
              let info = socketInfo(directory: directory),
              info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
              info.st_mode & 0o777 == 0o600 else { throw ClientError.unavailable }

        let path = directory.appendingPathComponent("speech-presentation.sock").path
        guard path.utf8.count < 104 else { throw ClientError.unavailable }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ClientError.unavailable }
        defer { Darwin.close(fd) }
        var noSignal: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        let copied = path.withCString { source in
            withUnsafeMutablePointer(to: &address.sun_path) { target in
                target.withMemoryRebound(to: CChar.self, capacity: pathCapacity) {
                    strlcpy($0, source, pathCapacity)
                }
            }
        }
        guard copied < pathCapacity else { throw ClientError.unavailable }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw ClientError.unavailable }

        let event: [String: Any] = [
            "protocolVersion": 1,
            "type": "display_reply",
            "text": text,
            "createdAt": Date().timeIntervalSince1970,
        ]
        var payload = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
        payload.append(0x0A)
        guard payload.count <= 4096 else { throw ClientError.unavailable }
        try writeAll(fd, payload)

        var response = Data()
        var byte = UInt8.zero
        while response.count <= 4096 {
            guard Darwin.read(fd, &byte, 1) == 1 else { throw ClientError.invalidResponse }
            if byte == 0x0A { break }
            response.append(byte)
        }
        guard let object = try JSONSerialization.jsonObject(with: response) as? [String: Any],
              Set(object.keys) == Set(["ok", "reason"]), let accepted = object["ok"] as? Bool else {
            throw ClientError.invalidResponse
        }
        guard accepted else { throw ClientError.rejected(object["reason"] as? String ?? "") }
    }

    private static func socketInfo(directory: URL) -> stat? {
        let path = directory.appendingPathComponent("speech-presentation.sock").path
        var info = stat()
        guard lstat(path, &info) == 0 else { return nil }
        return info
    }

    private static func writeAll(_ fd: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, base.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw ClientError.unavailable }
                offset += count
            }
        }
    }
}
