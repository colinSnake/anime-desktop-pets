# macOS 桌边小崽宿主

SwiftPM 应用位于本目录；`Package.swift` 定义 `PetCore`、`PetCompanion` 和 `PetCoreTests`。

- `Sources/PetCore/`：配置、生命周期与控制模型，不负责 AppKit 窗口。
- `Sources/PetCompanion/`：原生宿主、视频、桌宠生命周期与桌面联动；`PetManagerWindow.swift` 为“实例管理 → 桌宠管理…”的本地多选窗口，`PetSourceTool.swift` 在后台调用现有 helper，无独立素材库应用。
- `Tests/PetCoreTests/`：Swift 离线测试，跨语言 fixture 仍从仓库根目录读取。

从仓库根目录使用 `scripts/build.sh`、`scripts/test.sh`、`scripts/petctl.sh`；
单独测试也可使用 `swift test --package-path apps/companion-macos --scratch-path .build`。
根目录共享配置、媒体和构建缓存，不在本应用内复制一套。

### 原生输入与编辑菜单

宿主进入窗口事件循环前安装 `ApplicationMenu` 的应用/编辑主菜单，与状态栏桌宠右键菜单分开。编辑项不指定 target，由 AppKit 响应链与原生校验处理粘贴、复制、剪切、全选、删除、撤销/重做及粘贴并匹配样式；所有原生 SwiftUI 输入共享此入口，不增加全局按键监听；聊天 Shift+Enter 仅使用所属输入框的本地事件桥，不读取剪贴板。控制测试服务器不安装主菜单。`CharacterTextEditor` 保留系统 TextEditor、绑定、焦点、右键菜单和输入法，只在所属原生 scroll view 上隐藏框内滚动条并防止 SwiftUI 布局重置；撤销/重做会同步回 SwiftUI 绑定，不改变外层页面滚动。测试仅用合成数据与独立命名剪贴板，不读取或覆盖用户的系统剪贴板。真实键盘/中文候选/右键菜单与跨应用焦点须在重建后人工验收。

## 有限自主表达

CharacterCore 的表达适应是独立三维状态，不修改稳定身份；CharacterMemory 持久化证据/修订与设置，CharacterUI 提供独立分享、撤销和重置。PetAIBubbleService 只处理粗粒度事件，默认关闭、持久限额，并使用无工具单请求模型边界；helper 预取文案留待下次空闲问候。`--acceptance-model`、`--acceptance-expression`、`--acceptance-reply` 仅用于显式批准的合成验收，共用12次请求账本，不启动正常桌面联动。见[桌宠自主表达与验收](../../docs/桌宠自主表达与验收.md)。

## 记忆工作区布局

`CharacterMemoryView` 只编排单一页面滚动、资料切换与添加流程；`CharacterMemoryComponents` 提供共用输入/卡片、图标文字下划线页签及88×26pt原生类别菜单，`CharacterMemoryRow` 负责条目编辑和修订操作。`ManagementActionButtonStyle` 与宿主桌宠页共享紧凑按钮，菜单标签与按钮进一步复用`ManagementControlSurface`（需使用button菜单样式，避免borderlessButton退化为16pt原生标题），避免重复实现字号/高度/禁用态。知识文件导入UI已移除，保留手动带来源添加和已有本地资料。相关回归：`CharacterMemoryLayoutTests`、`CharacterMemoryInputTests`、`CharacterChatRenderingTests`及`WorkspaceSurfaceTests`。
