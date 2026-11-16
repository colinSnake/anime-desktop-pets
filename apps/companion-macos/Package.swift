// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AnimeDesktopPets",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "PetCompanion", targets: ["PetCompanion"])],
    dependencies: [],
    targets: [
        .target(name: "PetCore"),
        .target(name: "CharacterCore"),
        .target(name: "CharacterMemory", dependencies: ["CharacterCore"]),
        .target(name: "CharacterUI", dependencies: ["CharacterCore", "CharacterMemory"],
                resources: [.process("Resources")]),
        .executableTarget(name: "PetCompanion", dependencies: ["PetCore", "CharacterCore", "CharacterMemory", "CharacterUI"]),
        .testTarget(name: "PetCoreTests", dependencies: ["PetCore"]),
        .testTarget(name: "CharacterCoreTests", dependencies: ["CharacterCore", "CharacterUI"]),
        .testTarget(name: "CharacterMemoryTests", dependencies: ["CharacterMemory", "CharacterCore", "CharacterUI"],
                    resources: [.copy("Fixtures")]),
        .testTarget(name: "PetCompanionTests", dependencies: ["PetCompanion", "PetCore", "CharacterCore", "CharacterMemory"]),
    ]
)
