# 鲸鱼妹本机开发素材

- 来源：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，固定提交 `fb38ce620576f5ed3735a99536d2b1a4a9eb313f`；按 [该版本 README 的许可段](https://github.com/PC2005-cloud/dsh-pet/blob/fb38ce620576f5ed3735a99536d2b1a4a9eb313f/README.md#许可) 追溯原文。
- 原型「溟月」：[上善无形](https://space.bilibili.com/4456176)；女仆鲸鱼娘设计：[ZipZipPipe](https://space.bilibili.com/4168597)。这是社区角色，不是 DeepSeek 官方形象。
- 角色采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)；另见[上游创作者声明](https://www.bilibili.com/opus/1247156596114456581)。上游代码 MIT 不用于改授角色或视频。
- 本项目仅从用户指定的固定 checkout 读取 `待机呼吸休闲.webm` 和菜单精选动作原片，不修改视频。来源提交、相对路径、字节数与 SHA-256 固定在 `config/local-companion-media.json`；启动前逐项校验，只有通过校验的动作会复制到权限为 `0700` 的本机临时会话。准备脚本对现有 `.local/pets/dafeiyu/` 只增量补齐缺失的动作，不覆盖封面、待机或已有文件。拖拽悬空反馈循环播放；「开心跃动」仅从约 3.75 秒起跳段截取到 5.3 秒，作为快速松手反馈。其他菜单动作按原片一次播放。
- 原封面保存在 `.local/pets/dafeiyu/cover-original.png`，现用 `cover.png` 是用户提供的 2× 版本；待机原片位于 `.local/pets/dafeiyu/videos/idle.webm`。所有素材只存本机，不进入源码或产品构建，不公开分发。
