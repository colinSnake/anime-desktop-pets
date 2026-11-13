import DragonCore
import Foundation

/// Synthetic candidates for the explicit offline preview. Never invokes the helper or imports assets.
enum WorkspacePreviewSources {
    static func operation(in directory: URL) -> PetManagerWindow.SourceOperation {
        { operation, paths in
            try await Task.sleep(nanoseconds: 350_000_000)
            let sources = (1...18).map { index in
                LocalPetSource(path: directory.appendingPathComponent("preview-pet-\(index)").path,
                               id: "preview-pet-\(index)", version: "1.0.0",
                               name: "演示小宠 \(index)", actionCount: 35, builtin: false)
            }
            if operation == "scan" {
                return LocalPetToolReply(ok: true, pets: sources, packages: nil,
                                         warnings: ["离线演示素材，不读取真实桌宠。"], failures: nil, error: nil)
            }
            let packages = try sources.filter { paths.contains($0.path) }.map {
                try PetPackageReference(id: $0.id, version: $0.version)
            }
            return LocalPetToolReply(ok: true, pets: nil, packages: packages,
                                     warnings: nil, failures: nil, error: nil)
        }
    }
}
