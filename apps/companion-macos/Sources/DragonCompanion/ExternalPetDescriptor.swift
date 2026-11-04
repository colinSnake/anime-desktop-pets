import AppKit
import DragonCore

struct ExternalPetDescriptor: Sendable {
    let url: URL
    let bundleIdentifier: String
    let catalog: PetAnimationCatalog?
    let buildVersion: String?
    let patchVersion: String?
    let assetsURL: URL?
    var supportsWindowControl: Bool {
        guard let data = try? Data(contentsOf: url.appendingPathComponent("Contents/Resources/DRAGON_PATCH.json")),
              let marker = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return marker["windowControlProtocol"] as? Int == 1
    }

    static func inspect(_ runtime: Runtime) throws -> Self {
        let url = runtime.configuration.resourceURL(runtime.configuration.externalPetAppPath, relativeTo: runtime.resources)
        guard url.pathExtension == "app", let bundle = Bundle(url: url),
              let identifier = bundle.bundleIdentifier,
              identifier != runtime.configuration.codexBundleIdentifier,
              let executable = bundle.executableURL,
              FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw ConfigurationError("外部桌宠应用缺失或无效；请先构建增强桌宠，或准备原版后显式选择 --full-pet")
        }
        let catalog: PetAnimationCatalog?
        let buildVersion = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let patchVersion = bundle.object(forInfoDictionaryKey: "DragonPatchVersion") as? String
        if identifier == "local.bailongpet.macos" {
            guard let resources = bundle.resourceURL else {
                throw ConfigurationError("白龙桌宠资源目录不可用")
            }
            let assetsURL = runtime.configuration.externalPetAssetsURL(relativeTo: runtime.resources)
                ?? resources.appendingPathComponent("outputs/白龙桌宠素材")
            guard FileManager.default.fileExists(atPath: assetsURL.appendingPathComponent("素材清单.json").path) else {
                throw ConfigurationError("桌宠动作素材目录不存在：\(assetsURL.path)。请检查 externalPetAssetsPath")
            }
            if buildVersion == "3" {
                catalog = try PetAnimationCatalog.inspect(root: assetsURL)
                return Self(url: url, bundleIdentifier: identifier, catalog: catalog, buildVersion: buildVersion, patchVersion: patchVersion, assetsURL: runtime.configuration.externalPetAssetsURL(relativeTo: runtime.resources))
            }
            guard let data = try? Data(contentsOf: resources.appendingPathComponent("DRAGON_PATCH.json")),
                  let marker = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  PetBuildIdentity.supports(buildVersion: buildVersion, patchVersion: patchVersion, metadata: marker) else {
                throw ConfigurationError("当前仅验证白龙 mac.3 原版或 Dragon 增强版，请检查版本")
            }
            catalog = try PetAnimationCatalog.inspect(root: assetsURL)
            return Self(url: url, bundleIdentifier: identifier, catalog: catalog, buildVersion: buildVersion, patchVersion: patchVersion, assetsURL: runtime.configuration.externalPetAssetsURL(relativeTo: runtime.resources))
        } else { catalog = nil }
        return Self(url: url, bundleIdentifier: identifier, catalog: catalog, buildVersion: buildVersion, patchVersion: patchVersion, assetsURL: nil)
    }
}
