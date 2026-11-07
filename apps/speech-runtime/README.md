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

自定义 TTS 播放前对 PCM 施加限幅增益。这可以提高数字输出电平，但不能覆盖 macOS 音量、硬件限制或修复源音频已有的削波失真。
