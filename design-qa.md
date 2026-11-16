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
