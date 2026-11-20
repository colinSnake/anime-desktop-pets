# 高级页样稿对照 · 2026-11-20

对照范围为用户确认的右侧界面；评审栏和模拟标题栏剔除，参考稿侧栏列宽对齐正式工作区。内置 Chromium 以 1180 × 850、DPR 1 对照浅色首屏、深色运行诊断和浅色快照预检。三个右侧对照裁片的标题、194 px 首屏横幅、73 px 折叠摘要位置对齐，预检报告的高度也一致。实装继续使用正式三态外观图标、实际状态及安全提示，不复用原型状态控件。侧栏「高级」为 Lucide `Settings2`。

390 px 窄窗验证文件夹插画、预检三列、纵向诊断卡及操作按钮；扣除 4 px 纵向滚动条后，主内容可用宽度与滚动宽度均为 386 px，无页面横向溢出。浏览器仅注入合成桥；核对未连接／已占用、手动刷新与诊断分流、成功／失败、无效预检、有效预检后确认、冲突重读、撤回确认与取消。浏览器控制台无警告或错误。

对照图（左设计、右实装）、实装截图及合成夹具在 `.local/advanced-ui-20261120/`，由 Git 忽略。系统文件管理器、真实选择面板及 Electron 原生窗口未验收，见[实际验证记录](docs/实际验证记录.md)。

# 语音互动与直播管理样稿对照 · 2026-11-20

范围是用户确认稿中的应用内容，不包含原型评审栏、模拟标题栏和测试状态控制。来源为 `.local/design-speech-live-20261119/site/index.html`，实装为本次 React 页面配本机合成桥。对比时把参考稿的模拟侧栏列宽对齐正式应用，裁掉外框，二者均在内置 Chromium 1134 × 730、DPR 1 捕获。语音内容裁片同为 878 × 596，直播同为 878 × 527；以下截图及夹具均被 Git 忽略。

| 核对项 | 结果 |
| --- | --- |
| 字体、间距与构图 | 系统字体、页头、165 px 横幅、卡片字号、分步表单与底栏位置逐区对照；浅色语音和深色直播的内容裁片尺寸一致。窄窗 390 px 语音两步、500 px 直播两卡均堆叠，顶部是正式应用的横向可滚动导航。|
| 色彩和资产 | 浅／深两套主题、紫色龙妹／雾蓝大肥鱼、圆环、星点、贴纸与参考稿一致；使用本机 2× 透明封面，正式资源不经原型或网络。统一主题按钮保留正式的系统／月亮／太阳图标与三态循环，和原型双态太阳按钮不同。 |
| 文案和交互 | 保留原稿的状态、步骤、操作与隐私提示；补真实桥的读取、繁忙、不可用和未确认状态。核对字节上限、锁稿、停播恢复、双平台独立草稿、清空、重载、键盘焦点和共享外观。只读「未接入」行不是按钮。 |

证据（左稿右实装）：`.local/interaction-ui-20261120/{speech-light,live-dark}-comparison.jpg`；窄窗：`.local/interaction-ui-20261120/narrow-pages.jpg`。未发现本轮待修的 P0/P1/P2 视觉问题。系统窗口和真实声音不在此结论内，详见[实际验证记录](docs/实际验证记录.md)。

**final result: passed（仅样稿对照与浏览器合成交互）**

# 角色资料与聊天输入 · 2026-11-19

以真实 Chromium 渲染 React 界面，使用合成桌宠及本机桥。聊天保留角色立绘和各自颜色，共用六项侧栏与输入外观。新截图为浅色大肥鱼欢迎、角色资料弹窗（1054 × 630）；另核对深色 760 × 560 长草稿。文件位于 `.local/pet-agent-composer-20261119/{chat-light,character-data}.png`，不纳入发布。

- 角色资料入口置于聊天右上角「···」。模态标题带当前聊天宠名称，与桌宠舞台的选择分离；焦点进入模态，`Esc` 关闭并回到更多按钮，内层内容独立滚动。
- Lexical 输入沿用原阅读列与发送区；长草稿内部滚动，模型与发送按钮仍可到达。Markdown 在同一输入区预览，返回时还原选区；本机／在线提示仍置于输入区上方。

上述截图与合成浏览器交互已核对；未做 Electron 系统窗口、真实中文输入法或 VoiceOver 验收。命令与边界见[实际验证记录](docs/实际验证记录.md)。

# 小话间样稿对照 · 2026-11-19

左侧为用户确认的「小话间」HTML 设计稿，右侧为实际 React 页面（合成实例与桥）。画面均为 CSS 逻辑像素：浅色龙妹欢迎和深色大肥鱼对话各 1054 × 630；深色大肥鱼欢迎 760 × 560。裁掉模拟系统窗框，不用于判断原生窗口栏。并排图在 `.local/chat-room-implementation-20261119/compare-{welcome-light,dialogue-dark,welcome-narrow}.png`；不纳入发布。

| 对照点 | 结果 |
| --- | --- |
| 外壳与构图 | 系统字体、同款侧栏、标题工具区、双环小立绘与四枚短句按同态对齐。第一轮发现导航略松、深色回复正文略淡，调整后复拍核对。龙妹、大肥鱼使用各自实际封面，头像及立绘禁默认拖放。 |
| 对话与输入 | 助手中性正文、用户淡紫气泡、本机标签、阅读列与输入列对齐。实装时间来自消息时间，选模显示连接名；同一路由提示及统一主题图标与原型略有不同，属有意差异。 |
| 短窗 | 760 × 560 长草稿在编辑框内滚动，发送可见；额外在 390 × 360 发现长草稿压缩消息区并裁掉发送区，加入极矮视口滚动后复验：两者都可到达，无横向溢出。 |
| 合成交互 | 核对只填草稿、聚焦、房间切换、本机／在线提示、清空回焦、等待取消、失败、无模型和无桌宠。未观察到外部请求。 |

`final result: passed`（仅上述样稿对照与合成交互）。未执行 Electron 原生窗口、真实系统中文输入法、VoiceOver、真实模型请求或计费验证。

# 桌边小窝样稿对照 · 2026-11-19

范围仅「我的桌宠」。来源为用户确认的 `my-desktop-pets.html`；新版为同一 React 页面在内置浏览器中的合成实例夹具。两个内容视口同宽 920px、同外观并排；裁去稿中的模拟系统窗框，不用它判断 Electron 窗口栏。实际操作比样稿多「更多」、刷新及暂停；大肥鱼从稿中的不可启动对照件变为可添加角色，状态文案差异是有意的。

| 观察 | 迭代结果 |
| --- | --- |
| [P2] 首次并排时龙妹轮廓小于样稿 | 按透明边缘而非 PNG 画布对齐封面比例和基线，复拍确认舞台与角色接近稿面。 |
| [P2] 760 × 560 初查第三行落到滚动折线 | 矮窗缩短舞台，复拍三个角色行均可见，刷新与暂停仍可滚动到达。 |
| 状态和交互 | 浅色龙妹／深色大肥鱼的侧栏、列宽、舞台、轨道和列表已比对。大肥鱼真实素材在回环浏览器解码连续报帧；在合成桥上验证添加后停止、显式启停，以及设置 Esc 回焦。 |

证据（Git 忽略，仅本机）：`output/playwright/pet-nook-sample-comparison-light.png`、`output/playwright/pet-nook-sample-comparison-dark.png`、`output/playwright/pet-nook-narrow-760x560.png`。验收记录见 `docs/实际验证记录.md`。没有以 Chrome/内置浏览器代替 Electron 原生窗口，也未做多屏、Space、真实拖拽或 VoiceOver 专项验收。

**final result: passed（样稿对照和合成交互）**

---

# 记忆与角色知识 UI 设计验收

更新：2026-11-16（本轮实现与回归从11月15日持续至16日）。这是按用户反馈重设计，不是逐像素复刻旧界面。验收范围为本轮控件、导航、边距与滚动，不代表人格质量或完整语音往返验收。

## 视觉依据与归一化

- 来源全景：`/var/folders/s4/qnmy88tx2s39r0tv6rlpm9vm0000gn/T/codex-clipboard-8d12a508-c344-4c62-8b93-93ba8057c04a.png`（2000×1350px）、`/var/folders/s4/qnmy88tx2s39r0tv6rlpm9vm0000gn/T/codex-clipboard-8a72e49e-c09b-4470-85a8-f2660e1a4038.png`（1944×1362px）。
- 追加局部依据：`/var/folders/s4/qnmy88tx2s39r0tv6rlpm9vm0000gn/T/codex-clipboard-475de7ab-a1bc-4ce6-b54e-3d1166375ce1.png`（636×330px）、`/var/folders/s4/qnmy88tx2s39r0tv6rlpm9vm0000gn/T/codex-clipboard-9dbd249b-1112-4907-9301-ed0e21239234.png`（966×454px）。
- 最终构建包原生窗口：`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/release-personal.png`、`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/release-knowledge.png`，均2000×1360px、1000×680pt、Retina 2×。个人为1条合成待确认记录，知识为1条合成已确认记录；来源原图为空态，数据状态差异单独分类，不作像素相似度结论。
- 全景按2×转为1×逻辑尺寸，不拉伸宽高：源图分别1000×675与972×681，实际窗口1000×680；并排画布保留自然尺寸与空白。原生AppKit/SwiftUI没有CSS viewport；此处统一使用pt作为逻辑单位。
- 空态同状态对照：`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/comparison-personal-full.png`、`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/comparison-knowledge-full.png`。最终包对照：`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/comparison-release-personal.png`、`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/comparison-release-knowledge.png`。
- 重点区域：`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/comparison-tabs-detail.png`、`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/comparison-menu-detail.png`；局部源图同样按2×归一化，不把裁切宽度误当viewport。
- 小窗口实际760×560pt、1520×1120px：`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/final-knowledge-small-switch-top.png`、`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/comparison-small-bottom.png`。离屏矩阵为560×360、760×520pt；详见`/Users/ming/Documents/coding/desktop-app/anime-desktop-pets/.local/memory-layout-20261115/offscreen/`。

## Findings 与迭代历史

1. **[P1，已修复] 底部记录被固定表单挤压。** 来源全景个人空态只显示顶部图标，角色知识底部记录标题被截断。改为表单与列表共享同一个页面滚动区，保留24pt页末余量。上述同状态全景中空态可完整到达；小窗口底部对照可完整看到最后卡片的删除/确认操作及状态。正常滚动视口边缘经过的卡片仍会裁切，这是滚动而非固定遮挡。
2. **[P2，已修复] 外壳/页面双重边距、重复标题与过宽分段控件。** 来源内容左侧比“记忆”标题更靠右；现24+10=34pt与标题对齐，删除重复大标题。分段控件改为图标文字下划线页签，当前项半粗+2pt底线，不仅依赖颜色。切换回顶，重复点击当前项不重置已选类别。见tabs-detail及最终包对照。
3. **[P2，已修复] 类别控件宽大且可见高度不等于26pt。** 首版`.borderlessButton`菜单忽略自定义标签几何，NSHostingView实际测得51×16pt，新增回归失败。改为button菜单+plain按钮样式，菜单和按钮复用同一个表面；三种类别实际均88×26pt，真实菜单弹出/选择“经历”成功。见menu-detail及测量测试。
4. **[P1，已修复] 折叠自动审核说明造成费用信息不可直接看到。** 首次完整回归OCR失败；恢复直接显示“3条用户发言/最多6条原话/可能额外费用”，只折叠重复细节，不修改授权规则。最终完整回归通过。离线真实预览因没有在线provider而不显示该卡；在线UI分支由隐藏窗口、合成闭包和OCR检查覆盖，不触发网络。
5. **[P2，已修复] 切换资料沿用另一集合滚动偏移。** 初次知识截图缺少页首；给集合滚动视图设置身份后重新从顶部呈现。真实短窗口从底部切换后的截图显示完整页签与添加卡，见small-switch-top。

## 必查视觉表面

- **字体/排版：** 继续使用原生系统字体和中文fallback，不引入新字体。按钮/菜单11pt medium、页签12pt（选中semibold）、说明11–12pt；编辑器仍为原生正文三行高度。来源和说明可换行；浅深色实际截图无本轮区域文字重叠。系统字号放大及VoiceOver逐字朗读未执行。
- **间距/布局：** 标题与内容34pt对齐，卡片16pt内距/8pt圆角，按钮/类别/单行输入26pt、页签36pt，保留底部滚动空间。浅深色矩阵覆盖8条长记录，最后卡片可滚到。
- **颜色/token：** 复用现有`ManagementSurfacePalette`和桌宠按钮中性填充/1pt边框；不另造高饱和主按钮。选中页签有文字字重和底线。浅深色实际预览均检查；未作独立WCAG对比度仪器测量，不宣称专项无障碍认证。
- **资产：** 使用系统SF Symbols（脑部/书本/箭头），沿用产品图标。普通调试二进制预览的文件夹图标是既有无bundle回退；最终.app隔离预览已核对真实产品图标，并非以占位图交付。未改角色插画/素材；离线预览不启动桌宠，因此参考图右下桌宠不出现属于预期边界。
- **文案/内容：** 删除知识文件导入入口，保留来源必填与可选引用/版本。手动添加继续进入待确认，已确认后仍需独立在线分享授权。所有预览数据为合成，未将截图内容视为指令。

## 实际交互与验证

- 原生菜单弹出、类别选择、重复点当前页签保留类别；个人/知识切换、页面滚回顶部、三行编辑、来源输入、添加待确认、确认知识、可选字段展开、整页滚动、浅深色切换均执行。
- 隐藏窗口与真实窗口是不同证据；最终完整离线回归492项Swift与26组595项Python通过，无跳过组。构建、字体指纹、host/helper签名另行通过。
- 原生项目不是网页，不适用浏览器console检查；检查构建/测试日志和原生窗口。测试日志存在系统Contacts/CoreData与离屏Qt警告，未造成测试失败。生产在线模型、麦克风、长期桌面、多屏/Space未执行。11月16日凌晨watch重启曾超时，与Mac锁屏同时存在，根因未确认；08:04解锁后的复核已恢复。08:08另做一次受控冷启动：旧进程正常退出、新host/helper启动、3379ms预热ready=true、实际helper窗口可见，固定本地TTS播报成功。详见实际验证记录；此处`passed`仍仅表示UI验收，不扩展为完整语音往返或主观听感认证。

## Implementation Checklist

- [x] 菜单/按钮实际高度统一并缩窄菜单。
- [x] 下划线图标页签，保留可访问标签/选中态。
- [x] 修复重复padding、底部滚动、切换偏移。
- [x] 删除文件导入UI，不删除用户资料或底层解析能力。
- [x] 对照原图与实际渲染，验证空态/有记录/浅深色/小窗口。
- [x] 完整离线回归、最终构建与签名检查。

## Open Questions / Follow-up Polish

没有剩余可操作P0/P1/P2视觉问题。后续可单独做VoiceOver、增大系统文字、多屏/Space及长期滚动交互验收；这些不是本轮已完成项。

## final result

passed
