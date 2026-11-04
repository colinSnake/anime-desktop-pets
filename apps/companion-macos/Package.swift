// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DragonCodexCompanion",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "DragonCompanion", targets: ["DragonCompanion"])],
    targets: [
        .target(name: "DragonCore"),
        .executableTarget(name: "DragonCompanion", dependencies: ["DragonCore"]),
        .testTarget(name: "DragonCoreTests", dependencies: ["DragonCore"]),
        .testTarget(name: "DragonCompanionTests", dependencies: ["DragonCompanion", "DragonCore"]),
    ]
)
