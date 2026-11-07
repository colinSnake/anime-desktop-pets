// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DragonCodexCompanion",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "DragonCompanion", targets: ["DragonCompanion"])],
    dependencies: [],
    targets: [
        .target(name: "DragonCore"),
        .target(name: "CharacterCore"),
        .target(name: "CharacterMemory", dependencies: ["CharacterCore"]),
        .target(name: "CharacterUI", dependencies: ["CharacterCore", "CharacterMemory"]),
        .executableTarget(name: "DragonCompanion", dependencies: ["DragonCore", "CharacterCore", "CharacterMemory", "CharacterUI"]),
        .testTarget(name: "DragonCoreTests", dependencies: ["DragonCore"]),
        .testTarget(name: "CharacterCoreTests", dependencies: ["CharacterCore"]),
        .testTarget(name: "CharacterMemoryTests", dependencies: ["CharacterMemory", "CharacterCore"]),
        .testTarget(name: "DragonCompanionTests", dependencies: ["DragonCompanion", "DragonCore", "CharacterCore", "CharacterMemory"]),
    ]
)
