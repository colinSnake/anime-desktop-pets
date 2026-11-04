import AppKit
import DragonCore
import Foundation

struct Runtime: Sendable {
    let resources: URL
    let state: URL
    let configuration: CompanionConfiguration

    static func load() throws -> Runtime {
        let env = ProcessInfo.processInfo.environment
        let resources: URL
        if let override = env["DRAGON_RESOURCE_DIR"] {
            resources = URL(fileURLWithPath: (override as NSString).expandingTildeInPath).standardizedFileURL
        } else if Bundle.main.bundleURL.pathExtension == "app", let bundled = Bundle.main.resourceURL {
            resources = bundled
        } else {
            resources = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("resources")
        }
        let state = URL(fileURLWithPath: ((env["DRAGON_DATA_DIR"] ?? "~/Library/Application Support/DragonCodexCompanion") as NSString).expandingTildeInPath)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let configURL = state.appendingPathComponent("companion.json")
        let template = resources.appendingPathComponent("companion.example.json")
        let config: CompanionConfiguration
        if FileManager.default.fileExists(atPath: configURL.path) {
            config = try .decode(Data(contentsOf: configURL))
        } else if FileManager.default.fileExists(atPath: template.path) {
            config = try .decode(Data(contentsOf: template))
        } else { config = .init(); try config.validate() }
        return Runtime(resources: resources, state: state, configuration: config)
    }
    var videoURL: URL { configuration.resourceURL(configuration.videoPath, relativeTo: resources) }
    var petURL: URL { configuration.resourceURL(configuration.petImagePath, relativeTo: resources) }
    var socketURL: URL { state.appendingPathComponent("control.sock") }
    var posterURL: URL { resources.appendingPathComponent("poster/home-background.png") }
    var petLibraryAppURL: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/DragonPetLibrary.app")
    }
    var petLibraryURL: URL { state.appendingPathComponent("PetLibrary", isDirectory: true) }

    func startupLaunchArguments(at app: URL) -> [String] {
        // Apply the occlusion switch only to Chromium-style bundles, not arbitrary native clients.
        let frameworks = app.appendingPathComponent("Contents/Frameworks")
        let chromium = ["Codex Framework.framework", "Electron Framework.framework"].contains {
            FileManager.default.fileExists(atPath: frameworks.appendingPathComponent($0).path)
        }
        return chromium ? StartupPresentation.chromiumLaunchArguments : []
    }

    @MainActor
    func codexURL() throws -> URL {
        let path = configuration.codexAppPath
        let url = path.isEmpty ? NSWorkspace.shared.urlForApplication(withBundleIdentifier: configuration.codexBundleIdentifier)
            : URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard let url, Bundle(url: url)?.bundleIdentifier == configuration.codexBundleIdentifier else {
            throw ConfigurationError("未找到匹配 Bundle ID 的 Codex：\(configuration.codexBundleIdentifier)")
        }
        return url
    }
}

/// Bounded metadata-only diagnostics: never account data, conversations, credentials or screen contents.
final class Diagnostics {
    private let url: URL
    init(root: URL) { url = root.appendingPathComponent("companion.log") }
    func record(_ event: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(event)\n"
        var data = (try? Data(contentsOf: url)) ?? Data()
        if data.count > 256 * 1024 { data = Data(data.suffix(128 * 1024)) }
        data.append(Data(line.utf8))
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
