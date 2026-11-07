import AppKit
import Darwin
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
        let state = try resolveStateDirectory(environment: env, homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
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

    static func resolveStateDirectory(environment: [String: String], homeDirectory: URL,
                                      fileManager: FileManager = .default) throws -> URL {
        if let override = environment["DRAGON_DATA_DIR"] {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath).standardizedFileURL
        }

        let support = homeDirectory.appendingPathComponent("Library/Application Support", isDirectory: true)
        let current = support.appendingPathComponent("AnimeDesktopPets", isDirectory: true).standardizedFileURL
        let legacy = support.appendingPathComponent("DragonCodexCompanion", isDirectory: true).standardizedFileURL
        try fileManager.createDirectory(at: support, withIntermediateDirectories: true)

        if let destination = try? fileManager.destinationOfSymbolicLink(atPath: legacy.path) {
            let resolved = URL(fileURLWithPath: destination, relativeTo: legacy.deletingLastPathComponent()).standardizedFileURL
            guard resolved == current, isDirectoryWithoutFollowingLinks(current) else {
                throw ConfigurationError("旧数据目录 DragonCodexCompanion 是非预期符号链接；为保护用户数据，未自动迁移。")
            }
            return current
        }

        let hasCurrent = itemExistsWithoutFollowingLinks(current)
        let hasLegacy = itemExistsWithoutFollowingLinks(legacy)
        guard !hasCurrent || isDirectoryWithoutFollowingLinks(current) else {
            throw ConfigurationError("AnimeDesktopPets 已存在但不是普通目录；为保护用户数据，未自动迁移。")
        }
        guard !hasLegacy || isDirectoryWithoutFollowingLinks(legacy) else {
            throw ConfigurationError("DragonCodexCompanion 已存在但不是普通目录或是符号链接；为保护用户数据，未自动迁移。")
        }
        if hasCurrent && hasLegacy {
            throw ConfigurationError("同时发现 AnimeDesktopPets 和 DragonCodexCompanion 两个数据目录；为避免覆盖或混合数据，请先备份并手动处理。")
        }

        if hasLegacy {
            let lockIsHeld = try InstanceLock.isHeld(at: legacy.appendingPathComponent("instance.lock"))
            guard !lockIsHeld else {
                throw ConfigurationError("桌边小崽仍在使用旧数据目录；请先正常退出应用，再重新打开以完成迁移。")
            }
            try fileManager.moveItem(at: legacy, to: current)
        } else if !hasCurrent {
            try fileManager.createDirectory(at: current, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
        }

        try fileManager.createSymbolicLink(atPath: legacy.path, withDestinationPath: current.lastPathComponent)
        return current
    }

    private static func itemExistsWithoutFollowingLinks(_ url: URL) -> Bool {
        var info = stat()
        return lstat(url.path, &info) == 0
    }

    private static func isDirectoryWithoutFollowingLinks(_ url: URL) -> Bool {
        var info = stat()
        return lstat(url.path, &info) == 0 && (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR)
    }

    var videoURL: URL { configuration.resourceURL(configuration.videoPath, relativeTo: resources) }
    var petURL: URL { configuration.resourceURL(configuration.petImagePath, relativeTo: resources) }
    var socketURL: URL { state.appendingPathComponent("control.sock") }
    var posterURL: URL { resources.appendingPathComponent("poster/home-background.png") }
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
    private let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    init(root: URL) { url = root.appendingPathComponent("companion.log") }
    func record(_ event: String) {
        let line = "\(formatter.string(from: Date())) \(event)\n"
        var data = (try? Data(contentsOf: url)) ?? Data()
        if data.count > 256 * 1024 { data = Data(data.suffix(128 * 1024)) }
        data.append(Data(line.utf8))
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
