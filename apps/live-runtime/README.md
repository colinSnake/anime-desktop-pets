# 独立直播消息运行时

`apps/live-runtime/` 是一个与桌边小崽宿主、动画 helper、Speech Runtime 解耦的直播消息基础模块。

当前交付的是**离线标准化与安全门控层**，不是 B 站或抖音真实连接器。它使用 Python 标准库，通过 JSONL 接收合成弹幕，完成：

- 平台和字段白名单校验；
- 文本清理与长度限制；
- 短期去重；
- 时间窗口限流；
- 有界队列；
- 启停、清空和状态查询；
- JSONL 事件输出，供未来平台适配器或宿主独立消费。

它不读取 API Key、Cookie、访问令牌或桌边小崽配置，不保存弹幕、日志正文或用户资料，也不发起网络请求。`display_name` 只在输入对象内短暂存在，默认不会出现在输出事件中。

## 独立运行

```sh
printf '%s\n' \
  '{"type":"message","platform":"fixture","message_id":"m1","text":"你好，龙妹"}' \
  '{"type":"drain","limit":1}' \
  '{"type":"shutdown"}' \
  | python3 apps/live-runtime/stdio_service.py
```

真实平台适配器应作为独立进程实现，将平台事件转换为 `message` 命令；不得把平台登录、网络重连或凭证处理塞入动画 helper。B 站优先、抖音后评估，必须先完成合法接入方式与协议审查。
`bilibili_adapter.py` 目前只提供一个无网络的边界校验器：外部连接器必须先把已审查的 B 站事件转换成 `type=chat`、短消息 ID、文本和可选显示名，再交给门控层。它不会解析原始 WebSocket/HTTP 帧，也不接受 Cookie、签名或令牌字段，因此不能被误认为真实 B 站连接器。
`source_session.py` 提供平台无关的连接生命周期状态机：启动、已连接、指数退避重连、失败封闭和停止取消。重复断连回调不会消耗额外重试次数，失败后的迟到 connected 回调也不会偷偷复活会话；必须显式重新 start。它不创建网络客户端，未来的独立平台 connector 只需注入自己的传输实现。
JSONL 服务也提供 `source_start`、`source_connected`、`source_disconnected`、`source_retry` 控制命令，返回 `source` 状态事件；这些命令只驱动状态机，不会自行建立网络连接。

## JSONL 命令

- `message`：提交一条合成或适配器已标准化的弹幕；当前允许 `fixture`、`bilibili`、`douyin` 三个平台标识，但不代表已连接这些平台。
- `drain`：取出最多 32 条已通过门控的消息。
- `start` / `stop`：启停并清空待处理队列。
- `source_start`、`source_connected`、`source_disconnected`、`source_retry`：推进平台无关的连接状态机。断连 `error` 仅允许 `network_error`、`auth_required`、`protocol_error`、`rate_limited`、`source_disconnected`、`unknown` 等固定错误码；不得传入平台异常原文。`source_retry` 只有到达退避时间才会进入连接中状态。这些命令不创建连接或联网。
- `status` / `ping`：返回有界计数、朗读状态（启用时）和嵌套的 `source` 生命周期快照，便于外部 connector 轮询而不依赖事件历史。
- `shutdown`：停止并退出。

计数仅保存在进程内，退出即丢弃。输出的 `accepted` 事件可由下游回复策略消费；本模块不生成回复、不调用模型，也不直接打开音频设备。若使用 `--announce`，模块会按冷却时间、每分钟上限和 latest-wins 规则额外输出 `speak` 事件，交给独立的本机 TTS 桥接层；它仍不会向直播间发送内容。

启用本地朗读交接的离线示例：

```sh
printf '%s\n' \
  '{"type":"message","platform":"fixture","message_id":"m1","text":"请读给我听"}' \
  '{"type":"shutdown"}' \
  | python3 apps/live-runtime/stdio_service.py --announce
```

要把 `speak` 事件交给已单独配置的本机 Speech Runtime，可使用文本桥接器；桥接器不打开音频设备，只把事件翻译为 `respond` 命令：

```sh
printf '%s\n' \
  '{"type":"message","platform":"fixture","message_id":"m1","text":"请读给我听"}' \
  '{"type":"shutdown"}' \
  | python3 apps/live-runtime/stdio_service.py --announce \
  | python3 apps/live-runtime/speech_bridge.py --forward-stop \
  | python3 apps/speech-runtime/stdio_service.py
```

这条管线仍不会连接直播平台，也不会产生在线模型请求；Speech Runtime 是否实际播放声音取决于本机 TTS 配置和参考音频设置。

## 测试

```sh
python3 scripts/test-live-runtime.py
```
