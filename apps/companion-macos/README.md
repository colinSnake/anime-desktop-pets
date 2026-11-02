# macOS 伴侣宿主

SwiftPM 应用位于本目录；`Package.swift` 定义 `DragonCore`、`DragonCompanion` 和 `DragonCoreTests`。

- `Sources/DragonCore/`：配置、生命周期与控制模型，不负责 AppKit 窗口。
- `Sources/DragonCompanion/`：原生宿主、视频、桌宠生命周期与桌面联动。
- `Tests/DragonCoreTests/`：Swift 离线测试，跨语言 fixture 仍从仓库根目录读取。

从仓库根目录使用 `scripts/build.sh`、`scripts/test.sh`、`scripts/dragonctl.sh`；
单独测试也可使用 `swift test --package-path apps/companion-macos --scratch-path .build`。
根目录共享配置、媒体和构建缓存，不在本应用内复制一套。
