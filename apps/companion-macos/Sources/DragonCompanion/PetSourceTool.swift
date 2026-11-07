import AppKit
import DragonCore
import Foundation

struct LocalPetSource: Codable, Sendable {
    let path: String
    let id: String
    let version: String
    let name: String
    let actionCount: Int
    let builtin: Bool
}

struct LocalPetToolReply: Decodable, Sendable {
    let ok: Bool
    let pets: [LocalPetSource]?
    let packages: [PetPackageReference]?
    let warnings: [String]?
    let failures: [String]?
    let error: String?
}

/// Uses the existing animation helper in a no-window utility mode, off AppKit's thread.
struct PetSourceTool: Sendable {
    let executable: URL
    let library: URL
    let builtin: URL?

    init(runtime: Runtime) throws {
        let app = runtime.configuration.resourceURL(runtime.configuration.externalPetAppPath, relativeTo: runtime.resources)
        guard let bundle = Bundle(url: app), let executable = bundle.executableURL,
              bundle.bundleIdentifier == "local.bailongpet.macos",
              let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Resources/DRAGON_PATCH.json")),
              let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              metadata["localPetManagementProtocol"] as? Int == 1 else {
            throw ConfigurationError("当前动画 helper 不支持桌宠管理，请换用新版增强构建。")
        }
        self.executable = executable
        library = runtime.petLibraryURL
        builtin = runtime.configuration.externalPetAssetsURL(relativeTo: runtime.resources)
            ?? bundle.resourceURL?.appendingPathComponent("outputs/白龙桌宠素材")
    }

    func run(operation: String, paths: [String]) async throws -> LocalPetToolReply {
        var request: [String: Any] = ["operation": operation, "paths": paths, "library": library.path]
        if let builtin { request["builtin"] = builtin.path }
        let payload = try JSONSerialization.data(withJSONObject: request)
        let executable = executable
        return try await Task.detached(priority: .utility) {
            let fm = FileManager.default
            let temporary = fm.temporaryDirectory.appendingPathComponent("desk-cub-sources-" + UUID().uuidString)
            try fm.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? fm.removeItem(at: temporary) }
            let input = temporary.appendingPathComponent("request.json")
            let output = temporary.appendingPathComponent("reply.json")
            let errors = temporary.appendingPathComponent("errors.log")
            try payload.write(to: input, options: .atomic)
            fm.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
            fm.createFile(atPath: errors.path, contents: nil, attributes: [.posixPermissions: 0o600])
            let reader = try FileHandle(forReadingFrom: input)
            let writer = try FileHandle(forWritingTo: output)
            let errorWriter = try FileHandle(forWritingTo: errors)
            defer { try? reader.close(); try? writer.close(); try? errorWriter.close() }
            let process = Process()
            process.executableURL = executable
            process.arguments = ["--pet-sources"]
            process.standardInput = reader; process.standardOutput = writer; process.standardError = errorWriter
            try process.run()
            process.waitUntilExit()
            let size = (try fm.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0
            guard size > 0, size <= 128 * 1024,
                  let reply = try? JSONDecoder().decode(LocalPetToolReply.self, from: Data(contentsOf: output)) else {
                throw ConfigurationError("桌宠目录工具未返回有效结果（退出码 \(process.terminationStatus)）。")
            }
            guard process.terminationStatus == 0, reply.ok else {
                throw ConfigurationError(reply.error ?? "桌宠目录操作失败；请检查目录和素材格式。")
            }
            return reply
        }.value
    }
}
