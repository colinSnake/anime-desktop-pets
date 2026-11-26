# 本地语音运行时

本进程用于从源码目录运行的本地语音识别和可选参考音色合成。文字回复由桌面应用配置的在线服务生成；本进程不再加载本地 LLM。

## 当前 Electron 验收入口

Apple 芯片 Mac 的「语音互动」提供固定短句本机试听和独立停止；试听不接受页面自定义正文或路径、不联网，失焦、离页和录音取消试听。聊天按住说话须经麦克风授权，只生成可编辑的本机 ASR 草稿；是否发送由用户手动决定，普通聊天回复保持文字，不自动朗读。见[语音互动验证指南](../../docs/语音互动验证指南.md)；真实设备仍待人工验证，以下旧宿主记录不作为现役链路交付证据。已选 `~/.adpets` 业务根时，参考 WAV 副本、逐字稿和播报启用偏好都会持久化。重启总会恢复音频与逐字稿；上次启用时恢复启用并预载本机 TTS，但不自动播放或打开音频设备；上次关闭时只恢复资料。

现役 Electron 在显式启用后静默预载 TTS，首次写 PCM 才打开输出设备，连续 cue 复用 worker，模型准备阶段最多等待 30 秒的 `ready`；失败或超时会在语音页提示。已就绪后空闲 90 秒或确认停止后回收。Qwen 流式间隔为 0.32 秒（四个 codec 帧）。收到设备排空状态后，主进程才为匹配的气泡结束语音保留；取消／失败不伪报排空。

## 本地模型

- ASR：ModelScope `Qwen/Qwen3-ASR-0.6B`，转换为 8-bit MLX，位于 `.local/voice-runtime/models/Qwen3-ASR-0.6B-8bit`。
- TTS：ModelScope `Qwen/Qwen3-TTS-12Hz-0.6B-Base`，转换为 8-bit MLX，位于 `.local/voice-runtime/models/Qwen3-TTS-12Hz-0.6B-Base-8bit`。
- 文字 LLM：已移除，原 `Qwen3-1.7B-4bit` 目录已删除以释放空间；当前流程无需重新安装。

安装或转换 ASR 模型：

```sh
./scripts/install-local-asr-model.sh
```

Python 环境和模型权重保存在被 Git 忽略的 `.local/voice-runtime/`，尚未纳入应用安装包。ASR 安装脚本不会删除文件。参考音频应使用已获授权的素材，并提供准确转写。

## 气泡朗读预加载

现役 Electron 使用独立的 `bubble_speech_worker.py` 加载 TTS（`LocalMLXBackend.load(model, None)`），不加载 ASR 模型，也不导入 ASR 适配器；它不是 `stdio_service.py --tts-only` 命令行入口。worker 加载完成后发送 `ready`；预载阶段不合成音频，`SoundDevicePlayer` 仍在首次 PCM 写入时才初始化设备。仅在用户显式启用播报或从 `~/.adpets` 恢复为已启用时，宿主才异步预载；收到 worker 的 `ready` 才发送已接纳的 cue；取消或撤销的 cue 不补播。气泡、试听与直播台准备节目声轨共用一个 TTS worker。节目准备从同一个参考音色生成固定三句有界 WAV，通过独立的私有命令收集 PCM，不调用输出设备；准备期间不并发 ASR 或气泡/试听，完成后清理临时 WAV，不改变气泡偏好。气泡与试听共用播放槽，连续 cue 复用进程及输出流；空闲 90 秒或确认停止／禁用后回收 worker。按住说话与本机 WAV 转写使用独立 `voice_draft_worker.py`；开始录音或转写前会确认停止 TTS worker，ASR 结束后，窗口仍可见且工作区未全局暂停时才重新预载已启用的 TTS，且不改写保存的启用偏好。模型加载失败不阻止桌宠显示。预载减少首句等待，但不等于真实扬声器首音延迟已验收。

## 在线模型配置

从状态栏菜单打开“模型管理”，配置 OpenAI、DeepSeek 或自定义 OpenAI-compatible 中转。API Key 保存于 macOS 钥匙串，`model-provider.json` 仅保存厂商、Base URL 和模型名。请求和连通性测试可能计费，语音识别后的文本会发送给所选服务商。支持标准工具调用的端点可以触发 Open-Meteo 城市和当前天气查询；不支持工具调用的端点仍可普通聊天，但不能执行真实天气查询。

Codex 订阅登录凭证不能直接当作 API Key。中转可以通过自己的兼容端点和 Key 提供 Codex、Grok 等模型；兼容性、工具支持和价格由该中转决定。

## 运行时测试

```sh
python3 scripts/test-speech-runtime-service.py
python3 scripts/test-speech-runtime-session.py
python3 scripts/test-speech-runtime-queue.py
python3 scripts/test-speech-mlx-backend.py
```

`stdio_service.py` 接收有大小限制的 JSONL 命令，不接收在线 API Key。现役 Electron 的桌宠互动气泡和固定试听走本机 TTS；按住说话走独立 `voice_draft_worker.py`，从 stdin 接收有界 PCM WAV，只返回本机识别文本供编辑，不打开音频设备。输入来自用户显式选择的 WAV，或 Electron 隔离 preload 提交的 16 kHz 单声道 PCM。桌面端在 ASR 前关闭 TTS worker，ASR 完成后才按可见与全局暂停状态重新预载，避免两套 MLX 模型并行驻留；普通聊天回复仅显示文字，不自动朗读。诊断信息不记录 API Key、转写正文、音频内容或请求正文。

TTS 播放使用 24 kHz、单声道、PCM16 输出，并通过独立的有界缓冲线程持续喂给声卡；模型生成不会直接承担每个音频块的实时写入时限。连续轮次复用同一个打开的输出流；每轮先在有界时间内确认软件队列与设备缓冲都已排空，再报告完成。下一轮重新开始同一流，不重新打开设备。取消时丢弃输出，不等尾音放完。播放层不再固定放大 PCM，避免把接近满幅的模型输出推入限幅失真；实际响度由 macOS 和输出设备控制。


## 故障恢复与验收边界（2026-11-09）

音频工作线程失败会唤醒排空等待；排空最多等待30秒，关闭不向满队列塞入哨兵，阻塞输出尝试 abort 并有界等待。队列最多24块，每块最多5秒 PCM。初始化失败关闭已创建的流，空 PCM 不算首块音频；写入或排空失败报告 `playback_failed`，合成没有产生有效 PCM 则报告 `synthesis_failed`。只有 PCM 被输出层接受后报告 `audio_started`，软件队列与设备缓冲都确认排空后才报告成功 `idle`；这不等于实机听感验收。

MLX 单块生成、求值和 PCM 转换在工作线程中完成，避免占用 asyncio 协议循环；临时数组在返回 PCM 字节前释放。宿主对每条互动 cue 设置默认 180 秒上限；错误或取消会回收受控子进程。关闭设置窗口会取消待授权录音和当前语音轮次。

历史语音聊天审查见[语音聊天闭环审查](../../docs/语音聊天闭环审查.md)，不表示现役 Electron 已接入普通聊天自动播报。本轮自动化测试使用假设备、假 MLX、合成资料和受控子进程；真实模型首音、扬声器尾音、声音一致性和长时内存仍待人工验收。

## 有界合成往返验收

旧宿主的真实语音往返验收脚本已经退役。当前支持边界和历史结果见[迁移状态汇报](../../docs/macOS迁移状态汇报.md)与[实际验证记录](../../docs/实际验证记录.md)。
