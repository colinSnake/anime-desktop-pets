# 桌宠有边界自主表达实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 落地低风险人格适应和可控日常 AI 气泡，并提供不超过 12 次的合成真实模型/语音验收。

**Architecture:** 核心策略用独立纯函数与 Codable 状态，存储原子写入；UI 只管理授权与呈现。helper 通过本机 socket 发枚举事件，宿主独立服务生成文案并返回，旧情境不再显示。验收使用无工具单请求方法和持久请求账本。

**Tech Stack:** Swift/Foundation/SwiftUI/AppKit、Python/PySide6、现有 MLX ASR/TTS。

**Spec:** `docs/superpowers/specs/2026-11-15-bounded-pet-autonomy.md`

## Global Constraints

- macOS 13+；不读取/发送真实历史聊天或私人记忆。
- 真实模型最多 12 次（失败/超时计入），无自动重试。
- 日常 AI 气泡独立授权默认关闭，10 分钟冷却，每日最多 12 次。
- 适应只限三项表达维度，分享默认关闭，保留稳定身份与安全边界。
- 不提交、不重置既有改动；发布增强 helper 必须重建本机字体、检查指纹与签名。

### Task 1: 人格适应领域与持久化

**Files:** 新建 `CharacterCore/CharacterAdaptation.swift`、`CharacterMemory/CharacterAdaptationStore.swift` 及对应测试。
**Interfaces:** `CharacterAdaptationState` 保存 enabled/shareWithOnlineModel/修订与低风险维度；`observe(_ turn: CharacterChatTurn)` 返回是否变化，`rollback()`、`reset()`；store `loadAdaptation()` / `saveAdaptation(_:)`。
- [x] Red：`observe(明确简短反馈)` 有修订；引述/否定/凭证不调整；关闭/未分享不生成 prompt。
- [x] Green：实现有限明确反馈匹配、历史与原子落盘；状态不存在时默认本地学习、不分享。
- [x] 测试：`swift test --package-path apps/companion-macos --filter Adaptation`。

### Task 2: 合成验收与预算

**Files:** 新建 `PetCompanion/ModelAcceptanceRunner.swift`、`PetCompanion/ModelRequestLedger.swift` 及对应测试；main 负责 CLI 接线。
**Interfaces:** runner 注入 review 与无工具 reply 闭包，输出 Codable 报告；ledger 预留持久计数（最大12），所有网络入口在 reserve 成功后调用。
- [x] Red：第13次预留拒绝；重开账本保留计数；合成语料含稳定事实/偏好/经历、临时、疑问、否定、他人、冲突、敏感及注入。
- [x] Green：明确 precision/recall/逐字依据有效率/误保存/风险拦截分母；网络失败记录而不重试。
- [x] 测试：`swift test --package-path apps/companion-macos --filter Acceptance`。

### Task 3: 日常气泡服务与 helper

**Files:** 新建 `PetCompanion/PetAIBubbleService.swift`、`bailong/pet_ai_bubbles.py`、测试；修改 provider、control 协议、behavior 和交互补丁、设置。
**Interfaces:** 请求仅 `{command: "bubble", event: "idle|interaction|reminder"}`；响应使用现有 status message；没有文本上下文输入。
- [x] Red：默认不请求、10分钟/12日限额、失败计数、禁用后旧回复丢弃；helper 工作线程不操作 Qt、迟到情境丢弃。
- [x] Green：先显示本机兜底；后台预取、下一次同类事件消费一次性缓存，不替换已显示的气泡；同源朗读；开关说明发送内容/费用与固定限额。
- [x] 测试：Swift 聚焦测试、Python 气泡协议与既有 speech/behavior 测试。

### Task 4: 宿主/UI/验收接线与交付

**Files:** 修改 CharacterWorkspaceModel、context、identity UI、Main、相关文档、中英文 README、实际验证记录。
- [x] 将反馈适应接入成功用户轮次，关闭/回滚/重置与分享开关接入 UI；注入只使用明确授权的 bounded prompt。
- [x] CLI `--acceptance-model` 与 `--acceptance-reply` 在创建窗口前运行，仅合成输入；使用当前服务和 Keychain，凭证不输出。
- [x] 完成离线测试后控制器独占执行真实验收，账本总数不超过12；合成语音按真实 JSONL 协议做 ASR→模型→TTS，并记录非麦克风验收边界。
- [x] `swift test --package-path apps/companion-macos --quiet`、受影响 Python 测试、项目检查与 `git diff --check`。
- [x] 固定上游/本机字体 helper 重建→宿主重建→嵌入字体指纹与签名检查；允许时温和重启桌宠并静态检查，Codex 不动。
- [x] 如实记录本轮命令、结果/失败/跳过与未覆盖范围，复核改动，不创建提交。

## 执行裁决

用户已批准直接落地；按当前会话执行，不重复征求计划批准。预算由主控制器独占，子任务不得发在线请求。先本地阻塞路径（气泡协议与服务），独立的人格领域/验收工具可并行实现。

Ruling: helper 使用“提前异步生成、下一次同类事件消费缓存”，不替换已经显示/朗读的气泡 — 模型延迟通常长于气泡时长，缓存避免双播和迟到打断；代价是首次仍显示本地文案。缓存最多保留30分钟，使用前再次核对本地独立授权；事件发生时最多发一次请求，工作线程不触碰 Qt。


## 本轮收尾证据（2026-11-15）

- [x] 生产异步handler真实AF_UNIX回归：Red 3条断言失败 → Green 2项通过；最终全量Swift473项、Python26组595项通过，无实际跳过。
- [x] pet.44固定上游＋本机审核字体helper重建、生产接线修复后宿主再次构建、最终嵌入指纹/字体及宿主/helper签名与`--check`通过。
- [x] 正常`open`启动最终包后，语音预热ready=true、helper visible、status petVisible=true；互动朗读完成日志success。Codex PID678未变。此前TCC阻塞过程、恢复及边界如实记录。
- [x] 真实合成验收共11/12次；记忆小样本8/8、表达新对照301→80字符、ASR→模型→气泡→TTS排空通过；未新增模型请求、未开启日常AI授权、未提交或推送。
- [ ] 物理麦克风、主观听感/参考音色、多屏/Space/焦点、长期自然人格适应与实际日常AI缓存消费矩阵仍未完成，不以测试替代。

本计划实现项已落地；未验收边界不是实现已完成的证据。完整命令、分母、失败过程和日志入口见`docs/实际验证记录.md`。


## 继续推进：隔离整链与生命周期自动验收

- [x] 通过真实跨进程Socket连接生产handler和Python客户端，不改变产品授权/限额/模型逻辑。
- [x] 串联真实离屏Qt Pet、Bubble、SpeechCueClient和生产朗读入口，覆盖成功/失败/授权轮换三个场景；不进行真实TTS或播放。
- [x] 验证成功反馈跨store/窗口重开、独立分享、撤销/重置及48轮历史边界；不把同进程重开当作进程重启或长期人格质量验收。
- [x] 本机定向7项气泡＋2项人格通过；全量结果和审查结论以实际验证记录为准。

- [x] 独立审查发现探针继承环境、非阻塞证明不足、输出Pipe堵塞及超时未确认回收；已采用环境白名单、首次返回握手、临时输出文件、SIGTERM/仅自有进程升级回收，并新增3项安全回归。真实桌宠/Codex不动；最终复测结果见实际验证记录。

- [x] 最终加固后全量485项Swift＋26组595项Python通过，无实际跳过；独立复核原4项关闭，最终应用仍可见且朗读完成，账本11/12。


## 继续推进：人格存储与授权的真实分进程验收

- [x] 新增`CharacterAdaptationProcessTests`，7＋3＋2个阶段分别启动全新XCTest进程并等待退出，不复用内存会话；复用测试专有进程工具的环境白名单/超时回收，只显式传入固定阶段名。
- [x] 验证明确信息和证据落盘、重复轮次不写盘、分享授权、学习/分享撤销在新进程仍生效、单独恢复学习不恢复分享、回滚/重置屏障、48轮后30条历史及损坏资料拒绝覆盖。
- [x] 加入故障注入负对照：故意删除首阶段合成偏好文件，恢复阶段确实失败；还原测试后通过。不是生产故障或生产修复。
- [x] 同步中英文README、使用/测试说明及路线图；完整命令、审查及全量结果见实际验证记录。不付费、不重启真实桌宠或Codex、不创建提交。
- [ ] 正常产品重启/UI、异常断电/同时多进程写入、长期自然反馈效果和真人语音验收仍需分别完成，分进程存储测试不替代这些边界。

- [x] 独立审查补强分享撤权单独失效断言、将损坏注入移至子阶段，静态复核两项关闭；修正后最终聚焦15项、全量488项Swift＋26组595项Python通过，无实际跳过。
