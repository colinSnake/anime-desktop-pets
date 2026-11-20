# 桌边小崽 App 标识：角语（青蓝粉紫版）

图标设计：2026-11-02第二稿；产品文案更新：2026-11-04。用户可见称呼改为 **桌边小崽**，配文 **「让喜欢的角色，陪在桌边。」**。
这是 Anime Desktop Pets 管理/宿主 App 的产品级标识，使用 B「角语」的几何双角与对话折线，区别于聊天页 A「龙息」单色角色标志。图形抽象表达角色陪伴与对话，不是具体龙妹头像。

## 文案与兼容边界

- 菜单栏、提示标题与辅助功能名称：`桌边小崽`。
- 菜单栏悬停说明与 CLI 帮助配文：`让喜欢的角色，陪在桌边。`。
- 默认状态：`桌边小崽已就绪`；退出菜单：`退出桌边小崽`。
- 单实例提示：`桌边小崽已经在运行了；用 --status 查看状态，或用 --show 显示桌宠`。
- 未启动提示：`桌边小崽还没启动，先打开 App 再试试吧`。

文案集中在 `apps/companion-macos/Sources/PetCompanion/AppCopy.swift`，属于用户可见表达，
App文件名与CFBundleName/DisplayName现也统一为「桌边小崽」（宿主0.7.10/build30）。项目展示名仍为 Anime Desktop Pets；
2026-11-14起，内部可执行文件为 `PetCompanion`，Bundle ID为 `local.anime-desktop-pets.companion`，登录项和通用环境变量同步使用产品命名，不保留旧标识别名；数据仍存于 `AnimeDesktopPets`，但不再创建旧目录兼容链接。详见[产品命名与重建](../../docs/产品命名与重建.md)。
ad-hoc签名更新后，文稿文件夹及辅助功能授权可能需要用户在macOS系统设置重新确认；应用不会自动授予。
不迁移或覆盖用户配置，不把「已就绪」描述为已连接真实任务。

## 配色与图形

用户提供的截图用作**配色参考**：柔白外框、青蓝亮部、粉紫与浅桃色下部过渡。
按视觉近似选择下列色值，不宣称是截图原品牌色或精确取色；不嵌入原截图、不复制镜头造型。

| 用途 | 色值 |
| --- | --- |
| 柔白底座 | `#FFFFFF` → `#EFF0F8` |
| 渐层主色 | `#22D8F2` → `#459EFA` → `#B29CF4` → `#F4BFE7` |
| 局部柔光 | 青色 `#38F2F4`、浅桃 `#FFE0D0`、粉紫 `#C87CE9` |
| 窗口与底托 | 紫灰 `#49446E` |
| 白色伴星 | `#FFFFFF` → `#F4F2FF` → `#DFDEFF` |
| 小卫星点 | 奶油色 `#FFF2CD` |

应用图标将 B「角语」的对称几何路径等比例放大，主体使用柔白渐变，中央菱形使用奶油色，置于原有柔白外框和青蓝至紫粉底色上。小尺寸检查确认双角轮廓与中央记号仍可区分。该标识把产品与当前聊天角色建立轻度视觉关联，但不使用具体角色头像、月牙、镜头或官方 AI 平台标志，也不表示后台联网状态。

## 资产与生成方式

| 文件 | 用途 |
| --- | --- |
| `app-icon.svg` | 可编辑的 1024×1024 矢量版本，新工作区侧栏使用同一份 |
| `app-icon.png` | 1024×1024 RGBA 主图，外缘透明；macOS Electron 开发 Dock 使用同一份 |
| `petStatusTemplate.png`、`petStatusTemplate@2x.png` | Electron 工作区 macOS 状态栏的 16/32 px 单色模板，沿用旧宿主的窗口与伴星轮廓 |

单一几何与色彩源为根目录 `scripts/build-app-icon.swift`。SVG/PNG 共用渐变、形状与透明度定义，
通过系统 AppKit/CoreGraphics 与 `iconutil` 离线导出；**不是图片模型生成结果，没有付费调用**。单一源中的几何、PNG 与 ICNS 表示保持可复现。
调整后在仓库根目录执行：

```sh
swift scripts/build-app-icon.swift resources/branding
python3 scripts/test-app-icon.py
./scripts/build.sh --enhanced-pet
```

Electron 开发构建复用 SVG 与 PNG；旧宿主的 ICNS 输出已退役。
菜单栏状态项使用透明的窗口与伴星单色模板，由 macOS 适配菜单栏外观。新 Electron 开发构建直接复制 SVG、PNG 与两档模板，分别用于工作区、开发 Dock 与菜单栏。旧 Swift 宿主仍在内部绘制模板，继续使用原 ICNS；Electron 正式发行包配置及真实桌面显示待验。
不改官方 App 或第三方 `BailongPet.app` 的原图标，也不改安装位置。构建不会启动或安装应用，不刷新系统图标缓存；实际显示仍需用户验收。

## 可选图片模型提示词（未执行）

模型名保持 `gpt-image-2.5`；服务参数与首次付费请求确认仍是前置条件。

> Design an independent macOS desktop-pet manager icon for Anime Desktop Pets, with the friendly Chinese UI name 桌边小崽 (do not render text inside the icon). Preserve an original desktop-window outline, a soft four-lobed companion star emerging from it, and a small satellite dot. A generous pearl-white rounded outer tile surrounds a luminous cyan-to-blue upper field, blending softly into lavender, pink and pale peach below. Use a muted deep violet-gray window outline for small-size contrast, a milky-white star, and a tiny cream satellite. Restrained layering, clean vector-like curves, generous negative space, legible at 16–32 pixels. Transparent outside the outer tile. Borrow only the reference image's color relationship, not its camera-lens motif or geometry. No pet portrait, dragon, anime girl, moon, paw print, camera lens, lettering, chat bubble, or existing AI-platform logo. Output a single centered icon, not a mockup or grid.

本标识为本项目新绘制的几何资产，不由第三方桌宠素材描摹而来。参考截图的品牌及权属未识别，
不把截图本身作为可发布资产；未进行商标查重，不宣称独占权。第三方角色/媒体授权边界不变。
