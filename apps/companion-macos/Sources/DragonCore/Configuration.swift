import Foundation

public struct CompanionConfiguration: Codable, Equatable, Sendable {
    public var schemaVersion = 1
    public var codexBundleIdentifier = "com.openai.codex"
    public var codexAppPath = ""
    public var videoPath = "media/startup.mp4"
    public var holdAt = 11.3
    public var transitionStart = 12.7
    public var transitionEnd = 13.65
    public var launchTimeout = 60.0
    public var windowWaitTimeout = 30.0
    public var volume = 1.0
    public var playerMaxWidth = 1280.0
    public var petEnabled = true
    public var petImagePath = "pet/preview.png"
    public var petSize = 210.0
    public var hidePetInFullscreen = true
    public var taskFollowingEnabled = true
    public var petBackend = "native"
    public var externalPetAppPath = ""
    public var externalPetAssetsPath = ""
    public var themeEnabled = false

    public init() {}

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, codexBundleIdentifier, codexAppPath, videoPath, holdAt
        case transitionStart, transitionEnd, launchTimeout, windowWaitTimeout, volume
        case playerMaxWidth, petEnabled, petImagePath, petSize, hidePetInFullscreen
        case petBackend, externalPetAppPath, externalPetAssetsPath, themeEnabled, taskFollowingEnabled
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        codexBundleIdentifier = try values.decode(String.self, forKey: .codexBundleIdentifier)
        codexAppPath = try values.decode(String.self, forKey: .codexAppPath)
        videoPath = try values.decode(String.self, forKey: .videoPath)
        holdAt = try values.decode(Double.self, forKey: .holdAt)
        transitionStart = try values.decode(Double.self, forKey: .transitionStart)
        transitionEnd = try values.decode(Double.self, forKey: .transitionEnd)
        launchTimeout = try values.decode(Double.self, forKey: .launchTimeout)
        windowWaitTimeout = try values.decode(Double.self, forKey: .windowWaitTimeout)
        volume = try values.decode(Double.self, forKey: .volume)
        playerMaxWidth = try values.decode(Double.self, forKey: .playerMaxWidth)
        petEnabled = try values.decode(Bool.self, forKey: .petEnabled)
        petImagePath = try values.decode(String.self, forKey: .petImagePath)
        petSize = try values.decode(Double.self, forKey: .petSize)
        hidePetInFullscreen = try values.decode(Bool.self, forKey: .hidePetInFullscreen)
        taskFollowingEnabled = try values.decodeIfPresent(Bool.self, forKey: .taskFollowingEnabled) ?? true
        petBackend = try values.decode(String.self, forKey: .petBackend)
        externalPetAppPath = try values.decode(String.self, forKey: .externalPetAppPath)
        externalPetAssetsPath = try values.decodeIfPresent(String.self, forKey: .externalPetAssetsPath) ?? ""
        themeEnabled = try values.decode(Bool.self, forKey: .themeEnabled)
    }

    public static func decode(_ data: Data) throws -> Self {
        let result = try JSONDecoder().decode(Self.self, from: data)
        try result.validate()
        return result
    }

    public func validate() throws {
        func require(_ condition: Bool, _ message: String) throws {
            if !condition { throw ConfigurationError(message) }
        }
        try require(schemaVersion == 1, "不支持的配置版本")
        try require(!codexBundleIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Codex Bundle ID 不能为空")
        try require(!videoPath.isEmpty && !petImagePath.isEmpty, "资源路径不能为空")
        try require([holdAt, transitionStart, transitionEnd, launchTimeout, windowWaitTimeout, volume, playerMaxWidth, petSize].allSatisfy(\.isFinite), "数值配置必须为有限数")
        try require(0 < holdAt && holdAt < transitionStart && transitionStart < transitionEnd, "需要 0 < HoldAt < TransitionStart < TransitionEnd")
        try require((10...180).contains(launchTimeout) && (2...120).contains(windowWaitTimeout), "等待时间超出支持范围")
        try require((0...1).contains(volume), "音量需要在 0–1 之间")
        try require((480...3840).contains(playerMaxWidth) && (128...384).contains(petSize), "窗口尺寸超出支持范围")
        try require(["native", "external"].contains(petBackend), "桌宠后端只支持 native 或 external")
        try require(petBackend != "external" || !externalPetAppPath.isEmpty, "external 后端必须指定 App 路径")
        try require(externalPetAssetsPath == externalPetAssetsPath.trimmingCharacters(in: .whitespacesAndNewlines), "桌宠素材路径不能包含首尾空白")
        // A theme needs an explicitly configured and tested launch path; it is never silently injected.
        try require(!themeEnabled, "主题暂未自动接入；请使用独立 theme.sh 工作流验证，不要打开 themeEnabled")
    }

    public func resourceURL(_ path: String, relativeTo root: URL) -> URL {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") { return URL(fileURLWithPath: expanded).standardizedFileURL }
        return root.appendingPathComponent(expanded).standardizedFileURL
    }

    public func externalPetAssetsURL(relativeTo root: URL) -> URL? {
        guard !externalPetAssetsPath.isEmpty else { return nil }
        return resourceURL(externalPetAssetsPath, relativeTo: root)
    }

    public func opacity(at seconds: Double) -> Double {
        guard seconds.isFinite else { return 1 }
        let t = min(1, max(0, (seconds - transitionStart) / (transitionEnd - transitionStart)))
        return 1 - t * t * (3 - 2 * t)
    }
}

public struct ConfigurationError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
