# macOS 其它模块同步：合成资料兼容层

**目标：** 按已确认的 [macOS 功能迁移设计](../specs/2026-11-16-macos-feature-migration-design.md)，先把角色资料与语音／直播设置的旧格式语义迁入服务内部，页面设计后置。

**边界：** 纯 TypeScript 同步函数只接信任边界已拿到的有界字节及预期条目 ID，无文件查找、读写、导入入口或真实授权。旧 Markdown 的 JSON 头提供版本与元数据，正文只作为文本。旧语音设置分出历史请求与需要重新绑定的设备材料；旧设置不得打开网络、模型、录音、播报或直播。现有 React 页面和桌宠布局不改。pnpm 10.32.0；不安装、不提交、不推送。

- [x] **M2 角色资料。** 以 `CharacterMarkdownCodec.swift`、`CharacterIdentity.swift`、`CharacterMemory.swift`、`CharacterGoal.swift` 为来源。先在 `apps/app-service/test/legacy-character.test.ts` 写合成测试并观察失败，再实现 `src/migration/legacy-document.ts` 和 `legacy-character.ts`：身份 schema 1–2、记忆 1–4、目标 1–2；保留稳定 ID、时间、修订、来源、候选／确认态、期限、目标步骤及历史独立同意位。拒绝超限、损坏、未知版本、错 ID 或歧义字段。缺失身份时间用固定调用方时钟，不能随解码漂移。
- [x] **M4 语音／直播设置。** 以 `SpeechSettingsStore.swift` 为来源。先在 `apps/app-service/test/legacy-speech.test.ts` 验证历史显示、两项朗读开关、气泡授权代号、平台与房间彼此独立；再写 `src/migration/legacy-speech.ts`。保留历史意图及是否需要重新选择参考音频／设备；不返回旧的绝对路径、书签、麦克风 UID，不据旧同意启用新宿主能力。超限、坏文件、错误类型、未知版本明确失败。
- [x] **验证与同步。** 新测试、全量跨平台、项目检查、Git 空白检查；日志与上一轮分开。角色存储、显式快照导入、受限桥和运行编排均单独开发后才呈现可用入口。页面阶段按 Product Design 逐页基于现有工作区设计、验证，不让视觉状态替代业务证据。
