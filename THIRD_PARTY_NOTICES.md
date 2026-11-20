# 第三方来源与素材边界

根目录 MIT 许可证仅覆盖本项目原创源码，不覆盖第三方媒体、角色、商标或另行安装的工具。
这是独立的本地桌边小崽应用，不是 OpenAI 产品，也不是官方 Codex 插件。

## 1. 开发素材（不提交 Git）

- `resources/media/startup.mp4`：用户明确选择的本地
  `dragon-codex-boot/media/startup.mp4`。保留 `licenses/startup-media.md`。
  上游代码的 MIT 不授予提取、改授视频、角色、音乐或标志的权利。
  本地开发构建不等于获得公开分发授权。
- 龙妹：本机原封面来自 `bailong-desktop-pet-macos/docs/preview.png`，保存在 `.local/pets/longmei/cover-original.png`；现用 `cover.png` 为用户提供的 2× 版本，仅供私有开发参考。保留 `licenses/pet-reference.md`，不主张新增商用、改编或再分发权利。
- 大肥鱼：从用户明确指定的本机 `dsh-pet` checkout 提取固定待机原片并裁切透明封面；现用封面为用户提供的 2× 版本，只在 `.local/pets/dafeiyu/` 与临时会话使用。社区角色的署名与 CC BY-NC-SA 4.0 见 `licenses/local-companion-media.md`。
- 原创海报：尚未生成；后续生成后再记录服务、模型、来源与适用权利说明。

构建脚本会把本地媒体打进开发 App。它**不是已获授权的公开发行打包流程**，
所有素材权利明确前，不应再分发该 App。

## 2. 完整龙妹 Mac 辅助应用

新增本地依赖为 `chihayaanon210-spec/bailong-desktop-pet-macos` 的固定发布
`v0.4.1-mac.3`，下载地址、字节数与 SHA-256 记录在获取脚本及本地 `source.json`。
原始完整 App 原样保存在 `.local/`；默认构建改为复制本地增强版到 `Contents/Helpers/BailongPet.app`，
显式 `--full-pet` 可选择原样的上游版本。
上游源码、美术、动画、Python/Qt 组件和随附声明均按其各自许可适用，不被根 MIT 覆盖。
原始上游 App 与签名不变。增强版从固定源码的私有副本编译，保留原声明，使用自己的
ad-hoc 签名和补丁元数据。上游及衍生补丁按原许可适用，不被根 MIT 自动重新授权。

源码模板的静态参考路径与完整辅助应用是两种后端，不表示原生 Swift 实现了上游全部功能。
上游自带额度与对话入口，但本项目不自动调用或捆绑账号，不宣称真实任务验收已完成。

## 3. 上游来源声明的解读

`licenses/` 保留的是上游来源记录，其中“本项目”“此次发布”“已取得授权”或其他平台的测试结果，
指向原声明所描述的上游发布，不是桌边小崽应用新取得的授权或本机测试。
原文保留用于追溯，不能把其中对原发布者的授权扩大到本项目或任意下游用途。
本项目自身的测试结果只以 `docs/实际验证记录.md` 为准。

## 4. 设计参考与源码边界

参考 Dragon Codex Boot 的生命周期与覆盖层设计；参考 Wunsch2048 增强桌宠和
Kki1ds macOS 适配的任务映射、完成去重与异步播放思路。
没有把增强参考仓库改授为本项目 MIT。0.3.0 将固定 macOS 源码仅复制到被忽略的
本地暂存目录，保存可审阅的差异补丁和原创增强模块，重新编译 Python/Qt 辅助应用。
完整 25 动作来自原素材，不是 Swift 原生重写，
也不代表已经接入增强分支的现有 Codex 实时任务监听。

## 5. 系统框架与可选工具

AppKit、AVFoundation、AVKit、CoreGraphics、ImageIO、QuartzCore 是系统框架，
不是 Swift 宿主应用引入的第三方 GUI 运行时；完整外部桌宠另行随带 Python/Qt 等自身依赖。
可选主题脚本调用独立安装的 `codex-theme-studio`，没有复制该工具源码，
也不把它呈现为官方 API。

## 6. 本地扩展动作（0.5.0）

用户下载的 `jingh12312-rgb/bailong-desktop-pet` v0.5.1 包提供 4 新待机与 6 移动；
本工程在忽略目录中保留源 WebM、清单与随包声明，并无损转 WebP。
增强构建只将这 10 段与原 25 动作合并，写入 `outputs/PET_EXTRA_SOURCE.json` 来源和散列；
上游素材、第三方声明和项目的公开发行边界不变，不称为原创角色帧。

## 桌边小崽应用的原创几何标识（2026-11-02 设计初版）

`resources/branding/app-icon.svg`、`app-icon.png` 与 `AppIcon.icns` 由本项目
`scripts/build-app-icon.swift` 中新绘制的几何形状离线导出，不是龙妹媒体的描摹、
上游图标或图片模型生成结果。本项目原创几何资产随本项目原创源码适用根 MIT 许可；
这不涉及第三方桌宠角色、动画、媒体或平台商标的重新授权。标识尚待视觉确认，
没有进行商标查重，不承诺商标可注册性或独占权。

龙妹外观观察与提示词仅是对既有素材的描述性归纳，不恢复原始生成参数，
不使第三方角色成为本项目原创，也不授予新生成衍生角色的商用或再分发权利。

## 聊天编辑器与 DeepSeek Harness SDK

- Lexical、`@lexical/plain-text`、`@lexical/history` 与 `@lexical/utils` 固定 `0.49.0`，用于桌面聊天编辑，按上游 MIT 与各包附带声明。无移动 WebKit 补丁。`react-markdown` 固定 `10.1.0`（MIT），仅为本机草稿预览；禁用 HTML、外部链接及图片加载。传递依赖适用各自许可证。
- Ape Agent Harness 仅作本机架构和输入交互参考；不复制内部源码或产品数据。常规 macOS 开发服务通过 pnpm 直接固定 `@deepseek-ai/dsh-sdk-client` 和 `@deepseek-ai/dsh-llm-pi-ai` `0.2.2-rc.5`（MIT）；同版 `@deepseek-ai/dsh` 由 SDK 传递安装和解析。这些包保留自身许可证；其传递依赖适用各自许可。普通构建不复制完整第三方依赖树或 Node 二进制，独立分发需另做依赖与许可证清点。

## 工作区图标

- 「高级」导航使用 Lucide `Settings2`（Lucide 0.514.0 的 `icons/settings-2.svg`），仅内嵌该图标，不引入图标库运行时。原许可证保留于 `licenses/lucide.txt`。
