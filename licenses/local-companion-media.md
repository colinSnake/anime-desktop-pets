# 鲸鱼妹本机开发素材

- 来源：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，固定提交 `fb38ce620576f5ed3735a99536d2b1a4a9eb313f`；按 [该版本 README 的许可段](https://github.com/PC2005-cloud/dsh-pet/blob/fb38ce620576f5ed3735a99536d2b1a4a9eb313f/README.md#许可) 追溯原文。
- 原型「溟月」：[上善无形](https://space.bilibili.com/4456176)；女仆鲸鱼娘设计：[ZipZipPipe](https://space.bilibili.com/4168597)。这是社区角色，不是 DeepSeek 官方形象。
- 角色采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)；另见[上游创作者声明](https://www.bilibili.com/opus/1247156596114456581)。上游代码 MIT 不用于改授角色或视频。
- 本项目仅从用户指定的固定 checkout 读取全部 114 段原片（`待机呼吸休闲.webm` 与 113 段动作），不修改视频；与该版本 `assets/config.jsonc` 引用及 `assets/webm/` 文件清单逐项对应，无遗漏或额外文件。来源提交、相对路径、字节数与 SHA-256 固定在 `config/local-companion-media.json`；启动前逐项校验，只有通过校验的动作会复制到权限为 `0700` 的本机临时会话。准备脚本对现有 `.local/pets/dafeiyu/` 只增量补齐缺失的动作，不覆盖封面、待机或已有文件。拖拽悬空反馈循环播放；「开心跃动」仅从约 3.75 秒起跳段截取到 5.3 秒，作为快速松手反馈。其他菜单动作按原片一次播放。
- 原封面保存在 `.local/pets/dafeiyu/cover-original.png`，现用 `cover.png` 是用户提供的 2× 版本；待机原片位于 `.local/pets/dafeiyu/videos/idle.webm`。所有素材只存本机，不进入源码或产品构建，不公开分发。

## 全量动作与本机同步（2026-11-24）

- 源片合计 57,832,768 字节；保存到 `.local/pets/dafeiyu/videos/`，仍由 Git 忽略。来源、修订与许可保持不变，不将第三方视频或封面纳入提交。
- 右键「动作预览」包含 15 类：互动、日常、玩耍、拖拽反馈、待机观察、移动、小动作、吃什么、时节、文字、额度展示、碎碎念、工作状态、睡觉、开饭。待机由「回到待机」选择，合计覆盖全部 114 段。缺失或损坏的可选动作不展示。
- 原有 11 个动作 ID 保持不变。新增动作使用源文件名称 SHA-256 的前 12 位生成稳定 ASCII ID；中文菜单名称仍来自固定上游名称，源码不记录本机绝对路径。
- 睡觉／移动／额度／工作等条目仅播放原片，不接管窗口移动、不查询真实额度、不触发聊天或任务，也不实现源项目的完整睡眠状态机。悬空反馈可循环，其余菜单动作单次播放后回待机；拖拽回弹继续使用既有跃动片段及物理。
- 复用现有白名单、私有协议、代次确认及双解码器，不随动作数量预解码全部视频。准备命令仍为 `node scripts/prepare-local-companion.mjs <dsh-pet-checkout>`，只添加缺失的匹配原片；现有非匹配文件会报错，不覆盖。更新后需重开开发工作区加载新白名单及菜单，不自动重启现役进程。
