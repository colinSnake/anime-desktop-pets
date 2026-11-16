import Foundation
import ImageIO
import CoreGraphics

struct PetCoverSource: Hashable, Sendable {
    let directory: URL?
    let isPackage: Bool
    let fallback: URL?
    let maximumPixelSize: Int

    init(directory: URL?, isPackage: Bool, fallback: URL?, maximumPixelSize: Int = 512) {
        self.directory = directory
        self.isPackage = isPackage
        self.fallback = fallback
        self.maximumPixelSize = max(1, min(maximumPixelSize, 512))
    }

    static func builtin(runtime: Runtime) -> Self {
        .init(directory: runtime.configuration.externalPetAssetsURL(relativeTo: runtime.resources),
              isPackage: false, fallback: runtime.resources.appendingPathComponent("pet/preview.png"))
    }
}

/// 仅后台截取默认动画的第一帧，按素材包缓存；多个分身共用一张缩略图。
actor PetCoverLoader {
    static let shared = PetCoverLoader()
    private var cache: [PetCoverSource: CGImage] = [:]
    private var misses: Set<PetCoverSource> = []
    private var order: [PetCoverSource] = []

    func image(for source: PetCoverSource, refresh: Bool = false) async -> CGImage? {
        guard !Task.isCancelled else { return nil }
        if refresh {
            cache.removeValue(forKey: source)
            misses.remove(source)
            order.removeAll { $0 == source }
        }
        if let image = cache[source] { return image }
        if misses.contains(source) { return nil }
        let thumbnail: (URL) -> CGImage? = { Self.thumbnail($0, maximumPixelSize: source.maximumPixelSize) }
        let image: CGImage?
        if let archive = source.directory, archive.pathExtension.lowercased() == "petpack" {
            image = PetCoverArchive.thumbnail(in: archive, maximumPixelSize: source.maximumPixelSize) ?? source.fallback.flatMap(thumbnail)
        } else {
            image = preparedCoverURL(for: source).flatMap(thumbnail)
                ?? animationURL(for: source).flatMap(thumbnail)
                ?? source.fallback.flatMap(thumbnail)
        }
        if order.count >= 32, let oldest = order.first {
            order.removeFirst()
            cache.removeValue(forKey: oldest)
            misses.remove(oldest)
        }
        order.append(source)
        if let image { cache[source] = image } else { misses.insert(source) }
        return image
    }

    private func preparedCoverURL(for source: PetCoverSource) -> URL? {
        guard let directory = source.directory else { return nil }
        let base = directory.resolvingSymlinksInPath().standardizedFileURL
        let cover = directory.appendingPathComponent("workspace-cover.png")
        var info = stat()
        guard lstat(cover.path, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              info.st_size > 0, info.st_size <= 4 * 1024 * 1024 else { return nil }
        let resolved = cover.resolvingSymlinksInPath().standardizedFileURL
        guard resolved.deletingLastPathComponent() == base else { return nil }
        return resolved
    }

    private func animationURL(for source: PetCoverSource) -> URL? {
        guard let directory = source.directory else { return nil }
        let manifest = directory.appendingPathComponent(source.isPackage ? "manifest.json" : "素材清单.json")
        guard let size = try? manifest.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size > 0, size <= 1024 * 1024,
              manifest.resolvingSymlinksInPath().standardizedFileURL.deletingLastPathComponent()
                == directory.resolvingSymlinksInPath().standardizedFileURL,
              let data = try? Data(contentsOf: manifest),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let entry: [String: Any]?
        if source.isPackage {
            let actions = value["actions"] as? [[String: Any]]
            entry = actions?.first { ($0["id"] as? String) == (value["defaultAction"] as? String) }
        } else { entry = value["idle"] as? [String: Any] }
        guard let file = (entry?["playbackFile"] ?? entry?["file"]) as? String,
              !file.hasPrefix("/"), !file.split(separator: "/").contains("..") else { return nil }
        let base = directory.resolvingSymlinksInPath().standardizedFileURL
        let candidate = directory.appendingPathComponent(file).resolvingSymlinksInPath().standardizedFileURL
        guard candidate.path.hasPrefix(base.path + "/") else { return nil }
        return candidate
    }

    private static func thumbnail(_ url: URL, maximumPixelSize: Int) -> CGImage? {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= 64 * 1024 * 1024,
              let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ] as CFDictionary)
    }
}
