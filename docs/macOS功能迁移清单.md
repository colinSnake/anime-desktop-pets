# macOS 功能迁移清单

更新：2026-11-18。本文记录本轮源码盘点和迁移验收口径，不是已交付清单。

## 1. 用户确认的优先级

1. 长期主栈为 Electron + React/TypeScript/CSS + Node.js/Fastify + Python；使用 pnpm 10.32.0，不使用 npm。
2. **先完成现有 macOS 功能到新架构的平稳过渡，再恢复 Windows/Linux 播放器移植。** 最终三平台目标不变。
3. **功能对齐，界面重新设计。** 用户后续明确要求聊天以 macOS 聊天布局为基准、输入交互参考 deepseek-harness；此例外不改变其他页面的新设计方向。其他页面不复刻旧 SwiftUI/AppKit 页面；按新的信息层级、布局与组件体系改善美观和操作体验。行为、安全规则、数据与快捷键不能因换界面丢失。
4. 旧 Swift/Qt 版本保留回退；不得把合成测试通过、页面可见或设置已保存描述成真实桌面替代版已交付。

## 2. 状态口径

- **源码已有**：盘点到旧实现；不代表本轮执行、真实体验通过，或旧路线图全部完成。
- **开发接入**：新栈已有实现和合成验证，但不是产品发行或真实桌面验收。
- **待迁移**：新栈未接入；旧功能继续由旧版承担。
- **原有待验收/规划**：保留原状态，不把它列成旧版已经交付或要求先扩建的新功能。
- 本文每行只有列出的范围；各行测试与真实验收需要分别记录到[实际验证记录](实际验证记录.md)。本轮只是源码盘点，没有重跑历史业务测试。

下表的代码路径均相对仓库根目录。`Sources/` 简写指 `apps/companion-macos/Sources/`；Python 路径不使用该简写。

## 3. 功能与归属矩阵

| ID / 范围 | 旧实现入口与边界 | 新栈当前状态 | 目标归属 / 关键验收 |
| --- | --- | --- | --- |
| H01 工作区导航与外观 | `Sources/PetCompanion/WorkspaceSection.swift`、`CompanionWorkspaceWindow.swift`、`WorkspaceShellView.swift`；九个页面、主题与窗口重开 | 新导航/桌宠配置页/主题保存开发接入；桌宠页经用户确认收敛为macOS式紧凑控制行与封面卡片网格；设置采用用户确认的方案C右侧面板，固定标题/保存栏与独立滚动表单；卡片启动/停止、设置、更多三按钮等宽等高，分身/删除位于更多操作；保存状态与运行时应用确认分开，错误和草稿保护保留。移除英文副标题及迁移说明；主题按macOS语义改为全局顶部栏最右侧36px图标按钮，按系统→深色→浅色循环，侧栏不再放主题下拉框；诊断移至高级，其他业务页待迁移 | React 统一布局与路由状态；Electron 窗口重开。重新设计页面，不复制旧布局；键盘、窄窗、深浅色与真实窗口分别验收 |
| H02 原生应用菜单与状态栏 | `Sources/PetCompanion/ApplicationMenu.swift`、`Coordinator.swift`；编辑菜单、状态刷新、交互气泡语音开关 | 待迁移；开发壳关窗即退出，不常驻托盘 | Electron 菜单/Tray；命令状态来自服务，不用“投递成功”冒充完成；保留复制/粘贴/撤销等标准编辑 |
| H03 启动/观察客户端与视频过渡 | `Sources/PetCompanion/Coordinator.swift`、`BootPlayer.swift`；`Sources/PetCore/LaunchSession.swift`、`StartupPresentation.swift` | 待迁移 | TS 状态机及平台适配；跳过/超时/失败共享清理，不杀客户端、不残留遮罩；视频/声音/焦点需真实验收 |
| H04 窗口同步、全屏与权限 | `Sources/PetCompanion/WindowGeometry.swift`、`StartupWindowSizing.swift`、`PetWindowControl.swift` | 待迁移 | 独立 macOS 平台适配；不截图、不读窗口正文，不自动申请辅助功能权限；多屏/Space/全屏人工验收 |
| H05 本地控制与退出回收 | `Sources/PetCompanion/ControlSocket.swift`、`Sources/PetCore/ControlMessage.swift`、`scripts/petctl.sh` | 单宠 stdio 开发接入；旧 CLI 尚未迁移 | Fastify 领域操作 + 自有进程监督；命令逐项映射，不向页面暴露通用 shell；只清理自己拥有的进程 |
| P01 完整动画与静态/原版选项 | `apps/pet-runtime/bailong/`、`Sources/PetCompanion/ExternalPetDescriptor.swift`、`PetController.swift` | 仅 macOS 的隔离开发播放器；M1b 增加每实例显式启停，新启动进程用受限封面／待机首帧设应用和窗口图标（真实Dock待验收），非完整产品接入 | Python 保留异步解码/缓存/GUI 线程边界；原版和静态降级需显式，35 动作不得用一张图冒充 |
| P02 拖拽、甩动、手动动作与自主活动 | `apps/pet-runtime/bailong/dragon_behavior.py`、`dragon_playback.py` 及相关增强模块 | prepared 代码被复用；自主活动/移动保存值启动与运行中单独应用已开发接入，不改任务门禁及真实甩动例外；没有新架构真实手感验收 | 不重写物理；保留 24px / 150ms / 280px/s 门槛、二维轨迹、任务门禁和位置保存；合成 Qt 回归 + 人工手感 |
| P03 显隐、尺寸、全屏让位与偏好 | `Sources/PetCompanion/PetWindowControl.swift`、`apps/pet-runtime/bailong/dragon_visibility.py`、`Sources/PetCore/PetInstances.swift` | **部分开发接入：** 已保存尺寸/全屏隐藏策略和有效位置随显式启动应用；运行中可单独应用尺寸/全屏偏好并回报确认；会话显隐不写配置；拖拽松手位置由固定版本事件写回并递增 revision；UI 区分保存位置与运行时反馈；自主活动/移动保存值在每次启动及运行中显式应用，另列运行确认/失败；未验真实桌面 | 继续单独迁移暂停/任务跟随；应用失败不得伪更新或覆盖草稿；尊重旧尺寸调整暂停行为/全屏策略优先级，不绕过暂停与任务门禁 |
| P04 暂停/恢复联动 | `Sources/PetCompanion/Coordinator.swift`；启动/观察模式门禁与任务授权联动 | **部分开发接入：** 新工作区有易失暂停门禁；暂停停止服务自有播放器，拒绝实例/诊断播放器启动、显隐和偏好应用；停止未确认保持门禁关闭；解除仅解锁、不自动启动。旧任务租约及启动/观察模式恢复未迁移 | TS 状态机；门禁需覆盖每个新栈启动入口；停止/取消/关闭保守确认；旧客户端观察与任务授权单独迁移，不导入任务资料 |
| P05 多宠登记、克隆与删除 | `Sources/PetCore/PetInstances.swift`、`PetInstancePlanning.swift`；`Sources/PetCompanion/PetInstanceRuntime.swift`、`PetDeletionConfirmation.swift`；`apps/pet-runtime/pets/pet_instances.py` | 隔离配置登记/克隆/删除及逐实例启停已开发接入；3 个运行槽、每实例独立 PlayerRuntime/profile；非旧实例恢复或生产素材管理 | TS 实例领域/唯一写入；保留 32 个登记、默认 3 个运行上限、克隆默认停止、不复制媒体、停止确认后删除且不删素材和状态目录 |
| P06 首次单宠转多宠及自动恢复 | `Sources/PetCompanion/Coordinator.swift`、`PetInstanceRuntime.swift` | 待迁移 | 确认交接、旧进程退出确证、失败恢复；开发会话绝不接管旧宠，生产交接另获授权。单只启停与自动恢复语义不变 |
| P07 桌宠管理与本地多选添加 | `Sources/PetCompanion/PetManagerWindow.swift`、`PetSourceTool.swift`、`PetCoverLoader.swift`、`PetCoverArchive.swift`；`scripts/test-pet-sources.py` | **部分开发接入：** 新 React 页以无参主进程系统面板选目录或 `.petpack`，最多16项；服务端逐项调用现有受限校验/原子导入，失败逐项反馈；只在应用专用素材目录恢复 catalog，renderer 仅收文件名和包身份，不接触路径。导入包当前标记不可启动 | React 候选/实例交互；导入后停止态登记。扩展格式和可播放运行时另行迁移；不扫描旧素材目录、不恢复独立素材库应用 |
| P08 素材包校验与引用保护 | `docs/宠物库与素材包.md`、`apps/pet-runtime/pets/`、`scripts/test-pet-library.py` | **部分开发接入：** 复用既有路径、链接、ZIP 预算、媒体哈希/格式校验及同版本内容冲突拒绝；新工作区尚无素材删除入口，因而不能从 UI 移除仍被引用的包；引用锁定删除流程未迁移 | 单一素材存储与实例引用保护；任何后续删除能力必须拒绝仍被停止/运行实例引用的版本；不恢复已移除的独立素材库应用 |
| C01 身份资料与版本恢复 | `Sources/CharacterCore/CharacterIdentity.swift`、`Sources/CharacterMemory/CharacterMarkdownCodec.swift`、`CharacterMemoryStore.swift` | 待迁移 | TS 角色领域/Markdown codec；名称和字段限制、默认分享关闭、修订归档和恢复；读取未知/损坏版本不得覆盖原件 |
| C02 临时文字聊天与输入 | `Sources/CharacterUI/CharacterChatView.swift`、`CharacterWorkspaceChat.swift`；`Sources/PetCompanion/CharacterChatProvider.swift` | **部分开发接入：** React macOS式聊天页与原生输入、按新实例隔离的有界内存会话、取消／迟到作废／重试／清空确认；无正式回复适配器，发送禁用。模型服务、本机优先／在线回退和上下文尚未迁移；草稿跨页但不跨应用退出 | React 对话主界面 + TS 聊天编排；保留本机优先/在线回退、有界内存历史、取消和过时结果丢弃；不保存完整聊天日志 |
| C03 模型选择与上下文构造 | `Sources/CharacterUI/CharacterChatModelPicker.swift`；`Sources/CharacterCore/CharacterContextBuilder.swift`、`CharacterGoalContext.swift`；`Sources/PetCompanion/ModelReplyPolicy.swift` | 待迁移 | TS 上下文与回复策略；身份/授权记忆/知识/实时能力/目标各自边界，凭证过滤先于前 N 条检索 |
| C04 记忆、知识与检索 | `Sources/CharacterCore/CharacterMemory.swift`、`CharacterMemoryRetriever.swift`、`CharacterKnowledgeImport.swift`；`Sources/CharacterMemory/CharacterMemoryStore.swift` | 待迁移 | TS 领域和存储；来源/引用/版本与同依据冲突隔离；区分用户事实和角色知识，在线分享逐项授权 |
| C05 待审核、自动审核与写入撤销 | `Sources/CharacterCore/CharacterMemoryReview.swift`、`CharacterMemorySuggestion.swift`；`Sources/CharacterMemory/CharacterAutomaticReviewStore.swift`；`Sources/CharacterUI/CharacterWorkspaceMemoryReview.swift` | 待迁移 | TS 审核工作流；人工确认、持久同意版本、恢复/重复提交/凭证拦截；自动审核不绕过用户授权 |
| C06 目标、能力与表达适应 | `Sources/CharacterCore/CharacterGoal.swift`、`CharacterCapability.swift`、`CharacterAdaptation.swift`；`Sources/CharacterMemory/CharacterAdaptationStore.swift` | 待迁移 | TS 领域 + React 编辑；目标推进、实时能力/权限展示、适应可撤回；不改写核心身份，不把规划能力显示为可用 |
| M01 服务商配置与安全凭证 | `Sources/PetCompanion/ModelProvider.swift`、`ModelManagerWindow.swift` | 协议核心第一段：schema v2 多连接／模型校验、双层默认和路由快照已有；持久化、安全凭证及管理页未接入。按用户本轮指令参考独立多厂商设计，不再收窄为单服务 | TS 模型服务 + 主进程安全存储；页面不能读回明文密钥、不把密钥放 profile/日志；Keychain 导入单独确认 |
| M02 模型发现、刷新、请求与验收账本 | `Sources/PetCompanion/ModelDiscoveryClient.swift`、`ModelCatalogRefresher.swift`、`ModelProviderSingleRequest.swift`、`ModelRequestLedger.swift`、`ModelAcceptanceRunner.swift` | 服务内部四协议编解码、有界发现／请求、取消／超时及错误脱敏已有合成测试；没有生产路由、刷新合并或持久账本，不是可用服务接入 | TS 网络/请求生命周期与限额；后续接安全凭证／受限桥，再接管理页和聊天；真实付费验收需单独授权 |
| T01 Codex 任务跟随与任务租约 | `docs/Codex任务跟随.md`、`Sources/PetCompanion/Coordinator.swift`、`scripts/test-codex-tasks.py` | 开发播放器明确禁用；待迁移 | TS 只读任务适配 + Python 表现；先逐条移植原读取范围和租约规则，不顺带扩大 rollout 正文访问；不用真实聊天做自动化输入 |
| T02 额度气泡 | `docs/额度气泡说明.md`、`scripts/test-provider-quota.py`；prepared 上游及增强额度模块 | 开发播放器明确禁用；待迁移 | 保留用户显式查询、限宽/遮蔽与失败反馈；不自动查账号或把真实额度作为测试输入 |
| S01 语音/直播设置与同意 | `Sources/PetCompanion/SpeechSettingsStore.swift`、`SpeechSettingsWindow.swift` | 待迁移 | TS 版本化设置 + React 清晰分区；气泡朗读/回复朗读分离，参考音频与转写校验、持久同意版本不能丢 |
| S02 麦克风与语音聊天 | `Sources/PetCompanion/VoiceInputRecorder.swift`、`SpeechRuntimeSupervisor.swift`、`SpeechReplyText.swift`、`Coordinator.swift`；`apps/speech-runtime/` | 待迁移；旧版真实设备仍有待验收项 | TS 会话编排 + Python 既有 macOS 后端；显式授权、取消录音/推理/播报、关窗清理、冷/热恢复；本阶段不先移植其他平台推理 |
| S03 气泡、互动朗读与自主表达 | `Sources/PetCompanion/PetAIBubbleService.swift`、`SpeechPresentationClient.swift`；`docs/桌宠自主表达与验收.md` | 开发播放器明确禁用；待迁移 | TS 受限编排 + Python 本地气泡/音频；菜单交互等待、最后一条覆盖、短文本同源、限频、同意撤回、离线回退 |
| S04 直播来源与房间配置 | `docs/直播语音桌宠方案.md`、`apps/speech-runtime/`、`scripts/test-live-runtime.py` | 设置/来源底座已有；完整直播接入原本未完成，新栈待迁移 | 迁移已有设置和合成入口，不将规划中的真实直播平台接入标为旧功能或借迁移新增真实账号测试 |
| D01 配置、诊断与数据目录 | `Sources/PetCompanion/Runtime.swift`、`Sources/PetCore/Configuration.swift`；`docs/本地开发与使用指南.md` | 隔离版本化实例/主题存储开发接入；其余资料/生产导入待迁移 | TS 单一写入、原子保存、版本及损坏保护；主进程只开放经确认的数据目录/权限入口，不提供任意路径桥接 |
| R01 构建、字体、签名与回退 | `scripts/build.sh`、`scripts/build-pet-runtime.py`、`scripts/pet-build-inputs.py` | 新栈只有 checkout 依赖开发构建；无新安装包 | macOS 替代版先验证冷启动/退出/资源/签名及回退；SSRuanTangTi 字体仍受本机授权与指纹规则约束，不复用旧冻结 helper 冒充新源码 |

## 4. 数据归属与安全过渡

| 数据 | 旧来源 / 行为 | 新栈策略（待实现，非已执行迁移） |
| --- | --- | --- |
| 宿主设置 | `companion.json`，`CompanionConfiguration` schema 1 | 先用合成夹具实现白名单 codec/校验，再显式导入隔离根；启动视频路径不是可执行脚本 |
| 实例与素材 | `PetLibrary`、`pet-instances.json`、实例偏好/状态 | 实例 ID 与包 ID/版本稳定；不复制媒体、不删旧包。TS 权威实例定义；Python 只按命令应用窗口状态，上报运行时事实 |
| 身份、记忆与审核 | `pets/<petID>/character/` 下 Markdown 与 JSON；含修订和撤回状态 | 兼容旧 ID、格式、时间与版本；保存/撤回链路逐项比对。未知版本、链接、损坏或过大文件拒绝，不“修复”为空文件 |
| 模型与密钥 | `model-provider.json`、macOS Keychain、验收账本 | 非密钥设置与密钥分离；真实钥匙串不自动读取/批量搬运，安全存储适配不以明文导出替代 |
| 语音资料 | `speech-settings.json`、参考音频路径/书签、本地模型 | 同意版本与独立开关保留；旧书签不能当成通用路径；重新授权或兼容读取路径需明确 UI，不静默丢参考音频 |
| 窗口及任务运行态 | 窗口位置/物理时钟、租约、PID、socket、临时锁 | 不把活跃进程或租约当可导入配置；不复制旧 PID/socket/锁，不恢复未完成语音/模型请求 |

### 唯一写入与回退门槛

- 开发默认继续使用 `AnimeDesktopPets/cross-platform-dev` 和合成资料，不自动发现、读写真实旧资料。
- 后续真实过渡采用**明确授权的快照导入到独立新根**。先显示源格式/范围/冲突，再备份与导入校验；不在原根就地升级，不自动创建兼容链接。
- 不能只给 TS 加一把锁就宣称解决双写：旧 Swift/Qt 不认识新锁。生产切换需确认旧宿主及其拥有的 helper 已停止；不确定时拒绝接管，不强杀外部进程。
- 旧资料和旧可用应用保持原样；切回旧版使用旧快照。新版本运行后的增量不会自动出现在旧版，必须明确提示；没有经验证的逆向导出就不能宣称无损双向回滚。
- 配置持久化失败保留旧文件，显示真实错误；设置“已保存”“已应用”“运行中”分别建模，不能互相替代。

## 5. Windows/Linux 播放器阻塞台账（保留并暂缓）

| ID | 当前阻塞 / 开放条件 | 现在如何处理 |
| --- | --- | --- |
| WL-P01 | prepared 播放器仅 darwin 走异步 `AnimationFrameStore`，其他平台存在旧同步预解码路径；需移植线程/缓存边界并实测 | 保持 `blocked`；不降级到同步解码来伪造跨平台可用，不作为 macOS 业务迁移的前置条件 |
| WL-P02 | Windows/Linux 透明、置顶、点击/拖拽、缩放、多屏、全屏/托盘及进程退出缺少真实平台验证 | 暂缓窗口层移植和真实播放器矩阵；macOS 功能与稳定性达到替代门槛后重新排期 |
| WL-P03 | 旧多宠 Unix socket / uid / fcntl 通道非 Windows 可用；新单宠 stdio 已绕开旧通道，但未提供多宠业务等价能力 | 迁移多宠业务时沿用新受限传输，不以“改完旧 IPC”作为恢复全部平台的充分条件 |
| WL-P04 | 原生 Wayland 的全局定位/窗口跟随等受限；X11/XWayland 也未获实际验收 | 继续明确限制，不以环境变量或 CI 配置认定已支持 |
| WL-P05 | 各平台 Python/Qt/媒体打包、许可证、签名/安装和语音后端未完成 | 最终发行前分别验证；本阶段不扩建非 macOS 语音后端 |

Python 3.11+ / PySide6 / Pillow 仍是现有 prepared 播放器必要条件，不是解除以上阻塞的充分条件。三平台的合成协议/类型/构建 CI 可以保留；它不代表对应平台播放器已经验收。

## 6. 迁移批次与退出条件

| 批次 | 范围 | 退出条件（均未因本文而达成） |
| --- | --- | --- |
| M0 范围基线 | 本文矩阵、平台阻塞、数据边界、UI 改进要求 | 文档同步并对源码入口复核；不把“盘点”记作业务迁移 |
| M1a 配置/实例领域与新工作区基础 | TS 版本化配置/实例模型及隔离存储，React 新导航和桌宠管理首批交互 | 合成旧格式夹具、约束/错误/持久化测试；未接运行时的字段必须标注“待应用”，不能生成无效可点按钮 |
| M1b macOS 桌宠行为闭环 | 自有多宠启停/克隆/删除/偏好/恢复，素材添加与引用保护，暂停/显隐/尺寸/窗口反馈 | **部分开发接入：** 每实例显式启停、最多3个运行槽、阶段刷新、失败保守占槽、停止确认后删除；P03 尺寸/全屏策略启动应用与运行中单独应用、本会话显隐确认、位置启动应用和拖拽松手位置持久化已开发接入。自主活动/移动启动应用与运行中单独应用也已开发接入；新增最多16项的显式素材选择/逐项验证/受限导入与工作区 catalog 恢复，导入包暂不可启动且没有素材删除入口；暂停/任务跟随、动态引用保护删除流程、自动恢复与真实桌面验收仍未完成 |
| M2 角色和本地资料 | 身份、目标、能力、记忆/知识、修订、审核、撤回、表达适应及页面 | codec 与合成磁盘往返对照；默认不分享；重复提交、未知/损坏版本、跨角色隔离和重开恢复 |
| M3 模型及聊天 | **聊天 UI／内存会话及内部多厂商协议核心已第一段接入；生产模型服务仍未接线。** 后续持久配置／安全凭证、受限桥、模型管理／选择／发现合并、上下文、本机优先／在线回退及账本 | 内部四协议按独立设计分阶段实现；使用假模型／合成凭证回归，接线与自动测试齐备前不在页面开放协议选项；在线／付费另获授权 |
| M4 任务与语音表现 | 只读任务跟随、额度、现有 macOS ASR/TTS、录音与朗读、自主气泡、既有直播设置 | 租约/隐私门禁、同意撤回、同源短文本、故障恢复；设备/真实任务/账号/付费验收不自动执行 |
| M5 macOS 宿主与交接 | 启动视频/观察/窗口同步、状态栏、编辑菜单、窗口重开、CLI、权限入口、备份导入与发行 | 所有已有能力有对应实现和证据；冷启动/退出/多屏/Space/资源及生产导入/回退分别验收；再决定 Swift 退役 |
| M6 恢复其他平台 | Windows/Linux 播放器、各平台语音/安装和真实矩阵 | 单独规划；不阻塞前述 macOS 迁移 |

M1a 完成隔离配置/主题与新页面基础；M1b 已逐步接入实例启停、P03 显示偏好/位置/行为偏好及 P04 会话级暂停门禁。暂停状态易失，不写配置文件或增加 revision；暂停请求先关服务端门禁，再停止仅由本服务创建的多实例与诊断播放器。暂停期间不允许启动、显示或应用运行时偏好，仍允许停止清理及保存配置；任一停止未确认时保持 `stop-unconfirmed`，不释放实例槽且禁止解除暂停。解除暂停只开门，不自动重启；任务租约、客户端启动/观察及旧版模式相关恢复语义仍未迁移。显示配置、运行时确认值和会话显隐分别建模；位置写入失败保留最后一次成功配置。行为设置沿用旧 setter 和任务/甩动门禁，不导入任务状态。具体测试与未验收项见[实际验证记录](实际验证记录.md)。后续每批实现前必须有对应接口、失败处理与测试设计，完成一项才更新该项状态。页面布局与视觉方向见[macOS 迁移设计](superpowers/specs/2026-11-16-macos-feature-migration-design.md)。
