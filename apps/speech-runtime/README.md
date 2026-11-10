# 本地语音运行时

本进程用于从源码目录运行的本地语音识别和可选参考音色合成。文字回复由桌面应用配置的在线服务生成；本进程不再加载本地 LLM。

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

宿主为互动气泡使用 `--tts-only --tts-model <本机目录>`，不加载 ASR 模型，也不导入 ASR 适配器。进程加载完成后发送 `ready`；此时没有合成音频，`SoundDevicePlayer` 仍在首次 PCM 写入时才初始化设备。默认不带 `--tts-only` 的主动语音聊天仍按 `--asr-model` 加载 ASR。宿主在有效配置且已开启互动朗读时自动预加载，预览启动最多等待12秒；超时后仍等待最终 ready 才发送首条 cue，模型失败不阻止桌宠显示。关闭互动朗读会清除待播文本并在当前 cue 完成后释放 TTS 进程，模型仍在加载时会立即停止该受控子进程；快速重新开启会等待旧进程退出再启动预热。由气泡切换到主动语音聊天/演示时，宿主先关闭或停止尚未 ready 的 TTS-only 子进程再交接，避免并发占用模型内存。模型加载优化不等于真实首音延迟已验收。

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

`stdio_service.py` 接收有大小限制的 JSONL 命令，负责本地转写及可选的语音播放，不接收在线 API Key。Swift 宿主发起在线请求，只把生成的回复文本传回本地进程进行可选 TTS。诊断信息不记录 API Key、转写正文、音频内容或请求正文。

TTS 播放使用 24 kHz、单声道、PCM16 输出，并通过独立的有界缓冲线程持续喂给声卡；模型生成不会直接承担每个音频块的实时写入时限。连续轮次复用常驻输出流，单轮结束只排空当前 PCM 队列，服务退出时才关闭设备，减少重复初始化造成的首句延迟和卡顿。播放层不再固定放大 PCM，避免把接近满幅的模型输出推入限幅失真；实际响度由 macOS 和输出设备控制。


## 故障恢复与验收边界（2026-11-09）

音频工作线程失败会唤醒排空等待；排空最多等待30秒，关闭不向满队列塞入哨兵，阻塞输出尝试 abort 并有界等待。队列最多24块，每块最多5秒 PCM。初始化失败关闭已创建的流，空 PCM 不算首块音频；写入或排空失败报告 `playback_failed`，合成没有产生有效 PCM 则报告 `synthesis_failed`。只有 PCM 被输出层接受后报告 `audio_started`，排空成功才报告成功 idle；这不等于声卡实际听感验收。

MLX 单块生成、求值和 PCM 转换在工作线程中完成，避免占用 asyncio 协议循环；临时数组在返回 PCM 字节前释放。宿主对互动 cue、主动聊天与在线演示设置默认180秒轮次上限，错误/取消会回收受控子进程；关闭设置窗口会取消待授权录音和当前语音轮次。语音共用文字聊天的身份/目标/知识/记忆规则，朗读和气泡使用同一份最多160字符/512字节的短回复。

完整审查与未完成项见[语音聊天闭环审查](../../docs/语音聊天闭环审查.md)。本轮测试使用假设备、假 MLX、合成资料、mock HTTP 和受控 shell；真实模型、首音延迟、尾音、声音一致性和长时内存尚未复测。主动聊天的空闲卸载、通用打断和多轮语音历史仍需后续实现。
