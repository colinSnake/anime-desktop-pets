# Anime Desktop Pets 仓库指南

本文件是本仓库的协作入口，适用于仓库根目录及其子目录。开始工作前检查本文件和 `git status`；进入子目录后，继续查找并遵守更近的 `AGENTS.md`。用户最新明确指令优先。指南记录稳定约定和必要入口，不代替专题文档、路线图或验证记录。

## 项目概况

- 项目是 macOS 13+ 的轻量 Monorepo。产品展示名为 Anime Desktop Pets，macOS 应用文件名及系统显示名为「桌边小崽」。当前主要角色是对应 Codex 的龙妹；其他助手角色仍属规划，不代表客户端集成已交付。
- Swift/AppKit 宿主位于 `apps/companion-macos/`，负责应用生命周期、启动动画和外部桌宠协调；Python/PySide6 桌宠运行时位于 `apps/pet-runtime/`。完整动画由独立辅助应用播放。
- 本项目是独立应用，不是官方 Codex 插件；不修改或注入官方客户端。
- 实际仓库即当前工作目录。`/Users/ming/Documents/coding/github/codex-pet` 是只读参考项目，不是构建目录。固定上游及构建方法见[桌宠增强与性能构建](docs/桌宠增强与性能构建.md)和[完整桌宠接入说明](docs/完整桌宠接入说明.md)。
- 当前版本、用户确认过的决定和最新验证状态以[实际验证记录](docs/实际验证记录.md)为准；产品范围以[PRD](docs/prd.md)为准，未完成项以[路线图](docs/roadmap.md)为准。

## 目录与开发入口

- `apps/companion-macos/Sources/DragonCore/`：配置、状态机及可独立验证的核心逻辑。
- `apps/companion-macos/Sources/DragonCompanion/`：AppKit 宿主、视频、控制接口和桌宠生命周期。
- `apps/pet-runtime/bailong/`：龙妹播放、UI、行为和帧调度增强层；`integrations/bailong/` 保存固定上游接入补丁及清单。
- `scripts/`：构建、验证、预览和维护入口；通用宿主控制命令为 `scripts/petctl.sh`；`docs/`：需求、设计、使用及验证文档。

在仓库根目录执行：

```bash
# 修改增强运行时后，用本机已审核字体重建辅助应用，再重建宿主
LOCAL_TEST_FONT=".local/pet-build/local-fonts/上首软糖体.ttf"
python3 scripts/build-pet-runtime.py build --source-revision 8e5466d9a438deb6cb43f460e7f5a9bdb9d7a578 --local-test-font "$LOCAL_TEST_FONT"
./scripts/build.sh

# 离线回归；多宠/IPC 使用独立入口
./scripts/test.sh
./scripts/test-multi-pet.sh

# 只读检查当前构建状态，不启动正常桌面联动
./scripts/petctl.sh --check
```

环境准备、固定上游校验、素材与构建输入指纹要求见[构建说明](docs/桌宠增强与性能构建.md)。测试入口可能因缺少环境而跳过部分检查；必须查看实际输出，跳过不算通过。仅文档修改无需无故重建、安装或启动应用。

## 实现约定

- 优先沿用现有模块边界、工具和测试模式；修改保持在请求涉及的范围内。不要在 Swift 业务代码中写入本机绝对路径。
- 大型 Swift 文件/类型增加职责前，先按窗口编排、页面状态、领域操作和通用视图组件检查拆分点；一个类型只负责一个清晰职责。多个页面复用的布局、控件和样式收敛到通用组件，禁止复制粘贴形成近似实现；组件 API 保持窄小，领域状态和副作用留在所属控制器/Coordinator。拆分时保留既有行为并运行受影响的测试，不为拆分制造不必要的模块依赖。
- 新建通用文件、模块和命令使用产品/职责命名（如 `pet_*`、`speech_*`），不要把当前角色名 `dragon` 写进通用层文件名。`apps/pet-runtime/bailong/dragon_*` 是龙妹角色实现，保留角色名；`apps/pet-runtime/pets/dragon_instances.py`、`dragon_instance_ipc.py`、`dragon_pet_helper.py` 是待迁移的历史通用名，内容纳入冻结 helper 指纹，必须等固定上游可重建、兼容测试完成后成组迁移，不能留下失配的已发布 helper。
- 产品可见名称统一为「桌边小崽」。Bundle ID、内部可执行名与配置键保持兼容；用户数据默认位于 `~/Library/Application Support/AnimeDesktopPets`，旧 `DragonCodexCompanion` 只作为安全迁移及兼容链接路径保留。
- 完整增强版默认包含 35 个动作；`--full-pet` 明确选择未经增强的原版，`--native-pet` 是静态 PNG 降级。不要把静态图效果描述为完整动画播放器。
- 默认增强 helper 不内嵌动画素材。保持现有全局缓存、解码并发和线程边界；QPixmap 只能在 GUI 线程使用，真实绘制不得回退到同步 WebP 解码。实现细节见专题构建文档。
- **本机 SSRuanTangTi 构建铁律：** 当前桌宠消息气泡采用 `SSRuanTangTi` 时，任何交付给用户的增强版 `.app` 都必须通过 `python3 scripts/build-pet-runtime.py build --source-revision 8e5466d9a438deb6cb43f460e7f5a9bdb9d7a578 --local-test-font <已审核本机字体路径>` 重建 helper，再构建宿主。不得省略 `--local-test-font` 后直接发布/安装。发布前必须由 `scripts/pet-build-inputs.py` 校验最终嵌入的 `Contents/Helpers/BailongPet.app/Contents/Resources/fonts/上首软糖体.ttf` 与 `DRAGON_PATCH.json` 的 SHA-256，并通过 helper/宿主签名检查；任一缺失或不匹配都必须停止发布。字体仅限该用户授权的本机测试，不得提交、公开发布或再分发。
- 当前优先完成龙妹本机闭环，再考虑新增角色。真实桌面矩阵由用户选择安全时机，不自动启动应用或中断 Codex；自动化测试不能替代多屏、Space、焦点、长期资源和安装验收。

## 关键防回归要求

### AppKit Auto Layout

- 约束连接两个不同视图时，只有在它们已加入同一个视图层级后才能激活；独立构建的行/卡片不要提前约束到尚未接入的页面 `view`。先挂接父子视图，再统一激活跨视图约束。新增布局时通过离线工作区预览确认窗口真实可见，并在项目检查中覆盖容易回归的层级边界。

### Qt 原生崩溃

- 离屏预览必须在导入 Qt 模块前设置 Fusion 样式，并在创建 `QApplication` 后显式设为 Fusion；不要因此改变真实桌面应用的原生样式。回归入口：`scripts/test-preview-pet-ui.py`。
- 不要把 `QWidget.screen()` 返回的共享 `QScreen` 包装器设为短生命周期控件的子对象。查询可用屏幕时使用 `QApplication.screenAt(widget.frameGeometry().center()) or QApplication.primaryScreen()`；销毁自有气泡时显式关闭并 `deleteLater()`。回归入口：`scripts/test-qt-lifecycle.py`。
- 遇到崩溃先核对最新诊断报告的时间、进程、信号、原生栈和 Qt 版本；不要仅凭 Python 弹窗或类名推断根因，也不要反复触发已知崩溃。已知问题分类和修复证据见[实际验证记录](docs/实际验证记录.md)。

### 拖拽与松手甩动

- 任务活跃时阻止后台自主移动，但放行用户真实拖拽松手触发的甩动；检查 `release_drag()`、`perform_movement(released=True)` 和 `tick()` 三层门禁。不得通过清空任务状态或放行所有运动绕过限制。
- 拖动、活动弹簧及手动动作期间，任务跟随不得抢播姿态、气泡或清除轨迹。右键不得取消弹簧；只有左键开始新拖拽才中断旧轨迹。位置保存及无变化偏好更新不得重置姿态时钟或取消刚创建的弹簧。
- 保持甩动阈值至少 24 逻辑像素、最近 150ms 合速度至少 280 逻辑像素/秒；轻放不跳。保留二维初速、碰撞/摩擦、屏幕边界、独立物理时钟及收敛清理。
- 修改相关行为时运行 `scripts/test-real-pet-adapter.py` 与 `scripts/test-pet-runtime.py`，特别保留任务期间真实 Qt 合成拖拽、连续甩动、松手位置保存和设置门禁回归。完整清单见[实际验证记录](docs/实际验证记录.md)。离屏通过不得描述为真实桌面手感验收。

## 验证与证据

- 按修改范围运行测试，记录实际执行的命令、退出状态、通过/失败/跳过项和未覆盖边界。未运行必须写“未执行”；历史结果不可冒充本轮复测。
- 构建、签名、冻结 helper 自检、离屏测试、真实桌面验收是不同证据，不能互相替代。性能结论注明测量环境、时长和范围；不把测试通过写成真实任务或桌面交付。
- 用户要求修改功能、命令或当前运行状态时，更新相关专题文档及中英文 README；验证结论同步写入[实际验证记录](docs/实际验证记录.md)。文档语言约定：根 `README.md` 为英文、`README.zh.md` 为中文，其他自维护文档为中文；许可证等原文保留原样。
- 执行真实预览前确认用户明确要求；不要自动结束旧进程。真实额度、账号、聊天或任务不得作为自动化测试输入。

## 安全与数据边界

- 不修改官方 Codex 应用包、`app.asar`、Dock 配置、认证信息或对话数据；任务适配保持只读，不写 Codex 数据库。rollout 读取范围和正文处理约束见[Codex 任务跟随](docs/Codex任务跟随.md)。
- 未获明确同意，不重启 Codex、不安装或启用登录服务、不应用主题、不执行付费请求。不得强制终止可能持有任务的外部进程。
- 第三方应用、媒体、待审生成素材、本机密钥和用户数据不得提交或默认公开分发。保留来源和许可证原文；根目录许可证不覆盖第三方角色、代码、视频或音乐。
- 清理只针对确认不再使用的本项目构建产物。不得整体删除 `.local/`、`.build/`、唯一素材、配置、历史数据或验证证据；不得为清理而结束正在运行的桌宠。构建失败时保留最后一个可用版本。清理入口及磁盘规则见[本地开发与使用指南](docs/本地开发与使用指南.md)。

## Git 提交规范

- 提交标题统一使用 `<type>(<scope>): <中文祈使说明>`。`type` 和 `scope` 使用英文小写，多词 scope 使用连字符；说明与正文使用中文，命令、路径、版本及 API 等技术标识保留原样。
- 类型按目的选择：`feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`build`、`ci`、`chore`、`revert`。scope 应表达逻辑范围，例如 `host`、`runtime`、`pets`、`library`、`workflow`、`project`。
- 一次提交只表达一个逻辑目的。相关实现、测试和必要文档可同提交；无关改动分开。不得为拆分而制造缺少依赖的提交。
- 标题使用祈使说明，如“修复、增加、整理、同步、记录”，避免“已完成”“更新一下”等含糊表达。
- 正文说明原因、主要变化、影响范围和**真实验证结果**；列出实际执行命令及通过、失败、跳过和未验收边界。未运行的检查明确写“未执行”，历史结果不得冒充本轮验证。
- 仅在用户明确要求时创建提交。提交前检查状态和暂存差异，只暂存本次逻辑目的相关文件；复核 `git diff --cached`、`git diff --cached --check`。不得提交 `.local/`、构建产物、第三方素材、密钥、私有配置或用户数据。`.patch` 的空白上下文行按 `.gitattributes` 检查，不得为消除空白而破坏补丁。
- 未获明确要求不推送、不改写已有历史。提交后检查工作树并报告提交编号和剩余改动。
- 详细流程及示例见[Git 提交与协作规范](docs/Git提交与协作规范.md)。

## 文档入口

- [文档索引](docs/文档索引.md)：专题文档导航。
- [测试与人工验收](docs/测试与人工验收.md)：自动测试边界和真实桌面验收方法。
- [实际验证记录](docs/实际验证记录.md)：按日期记录版本、执行结果及待验收事项。
- [路线图](docs/roadmap.md)：龙妹本机闭环门槛和后续优先级。
