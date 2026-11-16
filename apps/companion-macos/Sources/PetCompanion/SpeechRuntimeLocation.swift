import Darwin
import Foundation

extension Runtime {
    var speechRepository: URL {
        Self.resolveSpeechRepository(resources: resources, environment: ProcessInfo.processInfo.environment)
    }

    /// Local builds record their checkout alongside bundled resources so Finder
    /// launches resolve the same private runtime as petctl, without a source path in Swift.
    static func resolveSpeechRepository(resources: URL, environment: [String: String]) -> URL {
        if let override = environment["PET_DEV_ROOT"], !override.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath).standardizedFileURL
        }
        let hint = resources.appendingPathComponent("speech-development-root.json")
        var info = stat()
        if lstat(hint.path, &info) == 0,
           (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), info.st_size > 0, info.st_size <= 4_096,
           let data = try? Data(contentsOf: hint),
           let root = try? JSONDecoder().decode(String.self, from: data),
           root.hasPrefix("/"), root == root.trimmingCharacters(in: .whitespacesAndNewlines),
           !root.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
            return URL(fileURLWithPath: root).standardizedFileURL
        }
        return resources.deletingLastPathComponent()
    }
}
