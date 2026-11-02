import Darwin
import Foundation

/// 固定版本上游 QLocalServer 的“唤回”接口：只建立本机连接，不发送数据或命令。
public enum LocalPetReveal {
    public static func connect(at url: URL) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeSocket,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { return false }
        let bytes = Array(url.path.utf8) + [UInt8(0)]
        var address = sockaddr_un()
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return false }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes + Array(repeating: 0, count: $0.count - bytes.count)) }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
        _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
            }
        }
    }
}
