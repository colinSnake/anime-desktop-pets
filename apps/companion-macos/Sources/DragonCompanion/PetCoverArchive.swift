import Foundation
import ImageIO
import CoreGraphics

/// Reads only the manifest and default clip from a .petpack; never extracts files into the source or library.
/// The system ZIP reader is bounded by output size and a deadline, and runs on PetCoverLoader's actor.
enum PetCoverArchive {
    static func thumbnail(in archive: URL, maximumPixelSize: Int) -> CGImage? {
        guard let values = try? archive.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= 256 * 1024 * 1024,
              let manifest = read("manifest.json", in: archive, limit: 1024 * 1024),
              let value = try? JSONSerialization.jsonObject(with: manifest) as? [String: Any],
              let defaultAction = value["defaultAction"] as? String,
              let actions = value["actions"] as? [[String: Any]],
              let action = actions.first(where: { $0["id"] as? String == defaultAction }),
              let member = (action["playbackFile"] ?? action["file"]) as? String,
              member.hasPrefix("assets/"),
              let data = read(member, in: archive, limit: 64 * 1024 * 1024),
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ] as CFDictionary)
    }

    private static func read(_ member: String, in archive: URL, limit: Int) -> Data? {
        // unzip treats member arguments as patterns. Reject pattern/control/path traversal characters.
        guard !member.isEmpty, !member.hasPrefix("/"),
              !member.unicodeScalars.contains(where: { $0.value < 32 || "*?[]\\".unicodeScalars.contains($0) }),
              member.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({
                  !$0.isEmpty && $0 != "." && $0 != ".."
              }) else { return nil }
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-p", "-P", "", archive.path, member]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 5, execute: deadline)
        defer {
            deadline.cancel()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
            try? output.fileHandleForReading.close()
        }
        var result = Data()
        do {
            while let chunk = try output.fileHandleForReading.read(upToCount: min(64 * 1024, limit + 1 - result.count)),
                  !chunk.isEmpty {
                result.append(chunk)
                guard result.count <= limit else { return nil }
            }
        } catch { return nil }
        process.waitUntilExit()
        guard process.terminationStatus == 0, !result.isEmpty else { return nil }
        return result
    }
}
