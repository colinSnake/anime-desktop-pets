# 龙妹与鲸鱼妹人格、记忆演进与双角色直播实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机工作区接入龙妹和鲸鱼妹各自的人格、逐项直播授权、角色专属舞台／音色，以及用户明确触发的偏好学习提案。

**Architecture:** 人格继续保存在现有按实例隔离的 CharacterRepository；固定角色模板和安全合约放在 contracts。`~/.adpets/live/` 分别持久化显式实例绑定、场景布局、逐项资料授权和每实例语音参考；可信 app-service 按绑定与授权组装单条 Pi 上下文。聊天与直播的单轮学习提案共用现有待审核记忆记录，用户确认前不影响人格或后续召回。

**Tech Stack:** TypeScript、React、Electron、Fastify、SQLite/现有私有原子文件存储、固定版 `@earendil-works/pi-agent-core@1.6.0`、pnpm 10.32.0。

**Spec:** `docs/superpowers/specs/2026-11-26-live-pet-persona-evolution-design.md`

## Global Constraints

- 使用 Node.js 24.x、pnpm 10.32.0 和 Python 3.10+；不使用 npm。
- Pi 仅调用现有 `ModelManagement`，不向 Pi 暴露 Key、Keychain、服务商地址、Shell、MCP、任意目录或工具。
- 不从未确认内容推断事实；学习只处理用户明确选中的单轮，并只提出 `偏好` 候选。
- `chatShare` 与直播授权完全独立，所有直播资料授权默认关闭；实例解绑／版本变化后不回退到其他实例。
- 直播媒体与语音按角色／实例固定校验，不跨角色回退；renderer 不接触本机绝对路径。
- 普通自动化不得调用真实供应商、消耗额度、启动 Electron／OBS 或访问真实个人数据。
- 未获用户明确要求，不提交或推送；不改写已有历史，不清理本机资料。
- 运行 `pnpm run check:cross-platform` 并记录完整结果；合成／离屏测试不代表真实桌面、TTS 听感或 OBS 验收。

---

## 逐项直播授权检查点（2026-11-27）

- [x] 先提交并推送现有鲸鱼妹独立静音舞台与隔离回归：`e65aff6`；远端分支已核对，提交后工作区干净。
- [x] 补齐 Task 3 / Task 8 的逐项直播资料授权：固定桥、当前绑定实例及资料版本复核、独立确认／撤回、冲突与结果未知重读。
- [x] 补齐解绑清除旧授权与重新绑定不恢复权限的回归。
- [x] 运行聚焦检查与全量跨平台检查，同步文档和实际验证边界：最终全量退出 0，跨平台 1091、build smoke 29，其余 workspace 3／tooling 48／runtime bridge 13 均通过，无失败或跳过。

此为上一阶段证据。后续两项仍直接使用同一 checkout，不新建或切换 worktree。

## 当前进度快照与执行调整（2026-11-27）

本快照按 2026-11-27 源码与验证更新。双角色画面、逐项直播授权、独立音色与显式单轮学习审核的检查点已推送（`db09fe8`）；随后在同一 checkout 补齐 Task 8 的空白身份草稿建议。当前 checkout 已通过隔离 Electron 自测：双角色静音舞台和实际本机 TTS、使用回环模型替身演练及人工审核。可按[本机试测清单](../../本机直播台使用指南.md#本机试测清单)开始试测；真实 OBS、听感、原生参考 WAV 选择与厂商计费仍待验收。

| 阶段 | 当前状态 | 证据／剩余工作 |
|---|---|---|
| Task 1：人格与角色合约 | 已完成 | 固定龙妹／鲸鱼妹人格建议、严格 package 匹配和角色动作目录已实现；合约测试通过。 |
| Task 2：绑定与布局存储 | 核心实现完成，故障路径测试未收口 | 角色绑定按 revision CAS 保存；服务按登记实例及 package 复核；profile v3 为两角色独立保存六套布局并迁移 v2 龙妹布局。已覆盖注册包匹配、删除实例拒绝、并发绑定及 rename／fsync 不确定结果；跨文件授权撤回已纳入解绑回归，真实运行仍待验。 |
| Task 3：授权与上下文 | 核心链路、管理 UI 与授权／解绑边界回归已接入；其余故障路径待补 | 直播授权默认关闭、独立于 `chatShare`；上下文仅按当前绑定实例选取已授权身份及未过期已确认记忆，并在受信服务内限制大小。知识类别、过期／候选／跨实例、修订变化与前端未知结果已覆盖；私有分享文件的底层发布故障注入仍可继续补强；页面已提供正文预览、逐项确认／撤回、冲突或结果未知显式重读；更换／解绑清除旧授权。 |
| Task 4：Pi 直播回合 | 核心链路已接入 | 角色、布景与单条弹幕进入固定 Pi 调用；媒体票据单次使用，语音前后复核当前角色／授权上下文。集成回归覆盖默认模型、纯文本字幕及语音票据。已补选模／凭证等待期间撤权拒绝出站、生成期间撤权拒发票据，以及真实 Pi／ModelClient 合成凭证 hook 回归；同步 dispatch 与票据／音频发布在实例及分享管理队列内复核修订。其余超时、取消和错误分支仍可继续补强。 |
| Task 5：双角色直播舞台 | 双角色画面／动作通过隔离 Electron 自测 | `e65aff6` 已提交并推送鲸鱼妹独立静音舞台、素材／动作隔离；本机交测 checkout 已通过首帧、手动动作、换景和停台自测，OBS 尚待验收。 |
| Task 6：每实例直播音色 | 接线与自动化验证完成 | 每绑定实例单独保存 WAV／逐字稿，角色三句和演练均使用自身音色；无样本静音，不回退。真实出声与听感未验。 |
| Task 7：单轮偏好学习与人工确认 | 接线与自动化验证完成 | 从成功演练或已保存的普通聊天选中单轮，单独确认后请求固定风格候选，再人工审核；不自动学习或授权。真实厂商和计费未验。 |
| Task 8：配置 UI、文档与验收 | 配置 UI 和文档已接入，真实验收待执行 | 保留角色绑定、逐项授权、独立音色与学习审核入口。身份页可手动为匹配登记的角色实例填入空白草稿，不自动保存、覆盖现有内容或授权。 |

**Task 6／7 最终检查：** `pnpm run check:cross-platform` 退出 0，合计 1266 项测试通过（含跨平台 1172、构建冒烟 30），无失败或跳过；14 个聚焦文件共 140 项通过。素材预检查因当前 checkout 缺少龙妹固定 WebM 归档退出 1，未到鲸鱼妹素材阶段；未启动应用或调用真实模型。过程中的故障与复测见[实际验证记录](../../实际验证记录.md)。

**本日较早检查点的验证（保留原证据；本轮最新见实际验证记录）：**
- `pnpm run check:cross-platform`：退出码 0；workspace 3 项、tooling 48 项、TypeScript 类型检查、跨平台测试 1062 项、runtime bridge 13 项、跨平台构建、build smoke 28 项均通过；失败 0、跳过 0。
- `pnpm exec tsx --test --test-name-pattern='rehearsal uses the real Pi text dispatch' apps/app-service/test/online-chat-dispatch.test.ts`：退出码 0；1 项通过。
- `pnpm run dev:desktop --check`：退出码 1；当前 checkout 缺少被忽略的龙妹本机归档 `.local/pets/longmei/videos/bailong-desktop-pet-v0.5.1-windows-x64-webm.zip`，未下载、未启动 Electron。此检查需在本机素材可用的工作区再验。
- 全程未调用真实供应商、未启动 Electron／OBS，未打开麦克风／扬声器或读取真实个人资料；合成结果不代表真实桌面及 TTS 验收。

**执行顺序调整：**先补 Task 2–3 的生命周期、持久化失败及授权上下文边界测试；随后接通并校验鲸鱼妹舞台素材／动作，完成每实例音色隔离；最后实现显式单轮偏好候选与人工审核，补齐逐条授权及管理 UI，再更新中英文 README、直播指南和验证记录。各阶段独立验证，完整端到端路径完成前不对外描述为自我演进交付。
## 文件职责图

- `packages/contracts/src/characters.ts`、`character-records.ts`、`live-stage.ts`：严格角色、人设、绑定、布局、授权及学习请求合约。
- `packages/contracts/src/character-personas.ts`：龙妹、鲸鱼妹固定人格建议；不持久化任何用户记忆。
- `apps/app-service/src/characters/repository.ts`：继续作为实例人格和候选记忆唯一写入者。
- `apps/app-service/src/live/role-bindings.ts`：新建角色到具体实例绑定的私有原子仓库。
- `apps/app-service/src/live/sharing.ts`：新建按实例、记录 ID 与 revision 管理的直播资料授权。
- `apps/app-service/src/live/profile.ts`：迁移场景布局为角色独立布局；保留现有六套场景。
- `apps/app-service/src/live/persona-context.ts`：新建绑定核验、直播资料筛选及 Pi 上下文构造，不执行模型调用。
- `apps/app-service/src/live/danmaku.ts`、`server.ts`：在可信路由内执行角色化直播 Pi 回合和数据准入。
- `apps/desktop/src/live-stage/{controller.ts,clock.ts,renderer.ts,assets.ts}`：角色化舞台代次、动作映射、固定媒体装载及首帧确认。
- `apps/desktop/src/{main.ts,service-process.ts,preload.ts}` 与 `packages/contracts/src/live-stage.ts`：固定 IPC、服务协议和角色选择传递；不暴露路径。
- `apps/app-service/src/speech/`、`live/routes.ts`、相关 speech contract：隔离每实例直播参考音频并保持现有 TTS 运行时门禁。
- `apps/workspace-ui/src/pages/`：人格建议应用、绑定与授权管理、每角色语音设置、直播单轮学习入口和候选审核。
- `apps/app-service/test/`、`apps/desktop/test/`、`apps/workspace-ui/test/`、`packages/contracts/test/`：按相邻生产模块建立拒绝路径优先的自动化回归。

## Task 1: 固定人格模板与直播角色合约

**Files:**
- Create: `packages/contracts/src/character-personas.ts`
- Modify: `packages/contracts/src/live-stage.ts`
- Modify: `packages/contracts/src/characters.ts`
- Test: `packages/contracts/test/live-persona.test.ts`

**Interfaces:**
- 输出固定角色 ID `longmei | dafeiyu`、对应 package reference、身份草稿模板及各角色固定直播动作目录。
- 动作目录为龙妹现有 `01/18/20`，鲸鱼妹使用 `companion-wave`、`companion-jump`、`companion-49c0d89c0992`；任何 renderer 输入不得新增动作 ID。

- [x] **Step 1: 写失败测试**：覆盖两份人格草稿所有 `identityFields`、互不相同的人格字段、`isIdentityDraft` 校验，以及未知角色／交叉动作／不匹配 package 的拒绝。
- [x] **Step 2: 运行定向测试确认失败**：`pnpm exec tsx --test packages/contracts/test/live-persona.test.ts`；预期因新导出和合约尚不存在而失败。
- [x] **Step 3: 实现最小合约与两份角色人格**：人格只包含角色自我定位、边界和表达风格，不带用户经历、记忆、知识或分享许可。
- [x] **Step 4: 重跑定向测试**：同一命令；所有模板字段和角色／动作验证通过。

## Task 2: 角色绑定、版本化直播布局与私有存储

**Files:**
- Create: `apps/app-service/src/live/role-bindings.ts`
- Modify: `apps/app-service/src/live/profile.ts`
- Modify: `apps/app-service/src/live/routes.ts`
- Modify: `apps/app-service/src/server.ts`
- Modify: `apps/app-service/src/entry.ts`
- Test: `apps/app-service/test/live-role-bindings.test.ts`
- Test: `apps/app-service/test/live-profile.test.ts`

**Interfaces:**
- `RoleBindingStore.read()` 返回绑定 revision 与角色到 `petID` 映射；`write(expectedRevision, bindings)` 执行原子 compare-and-swap。
- 服务在读写绑定、启动或取消直播时，以 `PetWorkspace.withRegisteredInstance` 校验实例仍登记且 package ID/version 正确。
- 布景 profile v3 为每角色保存六套摆位；严格迁移 schema v2 旧值到龙妹布局，只初始化鲸鱼妹默认值。

- [x] **Step 1: 建立核心回归测试**：现有测试覆盖 profile v2→v3 迁移、旧龙妹摆位保留、鲸鱼妹布局隔离、绑定 CAS／重复绑定拒绝、包不匹配及未登记实例拒绝。实现前曾观察到布局迁移测试按预期失败。完整权限及 durability 故障注入仍待补。
- [x] **Step 2: 运行核心定向测试**：`pnpm exec tsx --test apps/app-service/test/live-profile.test.ts apps/app-service/test/live-role-bindings.test.ts apps/app-service/test/live-sharing.test.ts packages/contracts/test/live-persona.test.ts`；本轮 13 项通过。
- [x] **Step 3: 实现绑定 store、固定路由与双角色布局迁移**：角色绑定按 revision CAS 保存，不接受 renderer 路径；不自动回退或挑选其他分身。
- [ ] **Step 4: 补齐生命周期及失败路径**：增加／运行 `pnpm exec tsx --test apps/app-service/test/pet-lifecycle.test.ts apps/app-service/test/live-profile.test.ts`，覆盖实例删除／换包竞态、符号链接、权限及 rename／fsync 未确认；故障时保留旧数据并要求重读。

## Task 3: 逐项直播资料授权与安全上下文

**Files:**
- Create: `apps/app-service/src/live/sharing.ts`
- Create: `apps/app-service/src/live/persona-context.ts`
- Modify: `apps/app-service/src/server.ts`
- Modify: `packages/contracts/src/characters.ts`
- Modify: `packages/contracts/src/character-records.ts`
- Test: `apps/app-service/test/live-persona-context.test.ts`
- Test: `apps/app-service/test/live-sharing.test.ts`

**Interfaces:**
- `LiveShareStore` 只保存实例 ID、记录 ID／当前 revision 与授权类别，不保存资料正文。
- `buildLivePersonaContext(workspace, characters, bindings, grants, role, question, scene)` 在注册实例队列内复核 package、当前身份／记忆版本和逐条授权，输出有界且可序列化的提示材料。

- [x] **Step 1: 建立核心回归测试**：当前覆盖授权默认关闭、与 `chatShare` 独立、绑定和身份 revision 变化后拒绝旧授权，以及未绑定角色拒绝。知识／过期／候选／大小上限等边界仍待补。
- [x] **Step 2: 运行核心授权测试**：上下文检查并包含在 `apps/app-service/test/live-sharing.test.ts`；随 Task 2 核心测试组合运行，本轮通过。
- [x] **Step 3: 实现直播授权 compare-and-swap 和上下文构造器**：授权只存实例、记录 ID／revision 与类别；上下文由可信服务复核绑定，不加入目标、聊天历史或附件。
- [ ] **Step 4: 补齐边界并验证兼容**：覆盖知识授权、候选／过期／跨实例排除、字节上限与不确定发布状态；运行 `pnpm exec tsx --test apps/app-service/test/online-chat-context.test.ts`，确认聊天授权行为未变。

## Task 4: Pi 直播回合接入绑定人格与授权资料

**Files:**
- Modify: `apps/app-service/src/live/danmaku.ts`
- Modify: `apps/app-service/src/server.ts`
- Modify: `apps/desktop/src/service-process.ts`
- Modify: `packages/contracts/src/live-stage.ts`
- Test: `apps/app-service/test/live-danmaku.test.ts`
- Test: `apps/desktop/test/live-stage.test.ts`

**Interfaces:**
- 内部请求接受固定角色 ID、布景和单条弹幕；不接受 `petID`、角色资料、路由或模型 ID。
- app-service 解析当前绑定并调用 `buildLivePersonaContext` 后，通过现有 `runPiAgent` 与保存默认模型完成回复。

- [ ] **Step 1: 写失败测试**：逐角色提示差异、仅带授权上下文、传入额外字段拒绝、输入当作非可信内容、模型路由前后变更、超时／断线取消、生成失败不出一次性合成票据。
- [ ] **Step 2: 运行 `pnpm exec tsx --test apps/app-service/test/live-danmaku.test.ts apps/desktop/test/live-stage.test.ts`** 并确认行为测试失败。
- [ ] **Step 3: 接入上下文构造与角色声线语气要求**：保留一条输入、56 字回复上限、固定默认模型、频率限制、票据绑定、语音就绪前不发布。
- [ ] **Step 4: 重跑定向测试**，检查 no-model、model-failed、rate-limit、speech-failed 状态及回复不会写入聊天历史。

## Task 5: 鲸鱼妹固定舞台素材、动作及角色布局

**Files:**
- Modify: `apps/desktop/src/live-stage/assets.ts`
- Modify: `apps/desktop/src/live-stage/controller.ts`
- Modify: `apps/desktop/src/live-stage/clock.ts`
- Modify: `apps/desktop/src/live-stage/renderer.ts`
- Modify: `apps/desktop/src/live-stage/index.html`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `packages/contracts/src/live-stage.ts`
- Test: `apps/desktop/test/live-stage.test.ts`
- Test: `apps/desktop/test/live-stage-assets.test.ts`

**Interfaces:**
- stage snapshot 增加固定 role ID；视频由可信 host 按固定角色 manifest 取用，renderer 仅接收安全媒体键和必要帧状态。
- 主进程使用现有鲸鱼妹 `config/local-companion-media.json` 固定 pin 从私有素材目录准备已允许片段，不传原始路径，不复制整套 114 段到舞台。

- [ ] **Step 1: 写失败测试**：鲸鱼妹 idle／三动作 pin 正确加载；角色切换只在停台时允许；错误哈希、缺片、role 与实例 package 不符、首帧失败时不亮舞台；交叉素材、交叉布局和迟到 frame 被拒绝。
- [ ] **Step 2: 运行 `pnpm exec tsx --test apps/desktop/test/live-stage-assets.test.ts apps/desktop/test/live-stage.test.ts`** 并确认新角色路径失败。
- [ ] **Step 3: 实现固定资源加载、双角色 snapshot／动作和布局**：保留龙妹媒体与动作行为；不使用未审核素材或备用角色片段。
- [ ] **Step 4: 重跑定向测试**，再运行 `pnpm run dev:desktop --check` 仅离线校验角色素材和播放器界面，不打开 Electron。

## Task 6: 每实例直播声线隔离

**Files:**
- Create: `apps/app-service/src/live/voice-profiles.ts`
- Modify: `apps/app-service/src/live/routes.ts`
- Modify: `apps/app-service/src/speech/bubble-speech.ts`
- Modify: `apps/desktop/src/service-process.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `packages/contracts/src/live-stage.ts`
- Test: `apps/app-service/test/live-voice-profiles.test.ts`
- Test: `apps/app-service/test/bubble-speech.test.ts`

**Interfaces:**
- 语音资料使用绑定实例 ID 并保存在 `live/voices/<petID>/`；无参可信桥暴露状态和固定选择器动作，不暴露路径。
- 每角色可单独准备三句舞台手动台词；无声舞台允许开台，但 voice not ready 时不开放弹幕／语音回复，不回退到另一角色参考音频。

- [x] **Step 1: 写失败测试**：角色声线默认隔离；仅固定选择器可提交符合 WAV 规则的副本；软链接、越界、换包、解绑、取消和写入不确定均安全失败；无参考时舞台无声且演练禁用。
- [x] **Step 2: 运行 `pnpm exec tsx --test apps/app-service/test/live-voice-profiles.test.ts apps/app-service/test/bubble-speech.test.ts`** 并确认 per-instance 语音测试失败。
- [x] **Step 3: 实现私有 voice profile、无路径 IPC 与角色化预合成**：不要读取、选择或复制任何未经用户逐角色选择的本机音频。
- [x] **Step 4: 重跑定向测试**，验证停台、取消、窗口隐藏和全局暂停撤销对应音频与任务。

## Task 7: 单轮偏好学习提案与人工审核

**Files:**
- Create: `apps/app-service/src/characters/learning.ts`
- Modify: `apps/app-service/src/characters/record-routes.ts`
- Modify: `apps/app-service/src/characters/repository.ts`
- Modify: `apps/app-service/src/online-chat.ts`
- Modify: `apps/app-service/src/live/danmaku.ts`
- Modify: `apps/workspace-ui/src/pages/MemoryPage.tsx`
- Modify: `apps/workspace-ui/src/pages/LiveDanmaku.tsx`
- Modify: `apps/workspace-ui/src/chat-session.ts`
- Test: `apps/app-service/test/character-learning.test.ts`
- Test: `apps/desktop/test/chat-memory-acceptance.test.ts`
- Test: `apps/workspace-ui/test/live-danmaku.test.ts`

**Interfaces:**
- 只接受 UI 明确选择并预览的单轮纯文本；服务按 session／instance 重新读取聊天 turn，或对 live 单轮使用短期内存 ticket，不接受 renderer 任意拼接上下文。
- Pi 最多选择一条限定为 `kind: '偏好'` 的固定表达风格；候选文案由本机生成，不持久化模型自由文本，也不额外保存源互动。
- 使用现有 CharacterRepository candidate→用户确认／删除闭环；仅确认后的偏好可经对应授权参与后续上下文。

- [x] **Step 1: 写失败测试**：未选轮、跨实例消息、带附件／工具内容、失败直播、双击、过期票据、输入长度越限、凭证、事实／知识／目标候选输出和重复确认均不写长期资料。
- [x] **Step 2: 运行新增学习服务、传输、前端状态机失败测试**。复测命令与范围以实际验证记录为准。
- [x] **Step 3: 实现 explicit learning request 和候选写入**：读取一条输入／回复，不加载聊天历史；Pi 失败或返回无效结构时不创建 candidate；拒绝候选使用现有删除闭环。
- [x] **Step 4: 实现 chat 与 live 确认交互**：live 学习确认框先展示唯一单轮；离页、关台、取消或失败清除内存上下文；默认页面仍不展示直播回复正文。
- [x] **Step 5: 重跑全部定向测试**，并验证普通聊天／直播历史中都没有自动出现原文或模型回复。

## Task 8: 双角色配置界面、文档与全量验证

**Files:**
- Modify: `apps/workspace-ui/src/pages/LivePage.tsx`
- Modify: `apps/workspace-ui/src/pages/IdentityPage.tsx`
- Modify: `apps/workspace-ui/src/pages/character-record-editors.ts`
- Modify: `apps/workspace-ui/src/pages/CharacterDataDialog.tsx`
- Modify: `apps/workspace-ui/src/pages/MemoryPage.tsx`
- Modify: `apps/workspace-ui/src/pages/interaction-pages.css`
- Modify: `docs/本机直播台使用指南.md`
- Modify: `docs/桌宠智能体方案.md`
- Modify: `docs/实际验证记录.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Create: `apps/workspace-ui/test/live-persona-ui.test.ts`
- Test: `apps/workspace-ui/test/identity-editor.test.ts`
- Test: `apps/workspace-ui/test/migrated-pages.test.ts`

**Interfaces:**
- 直播角色选择、实例绑定与角色语音是不同设置；所有写入均经固定桥并显示 revision 冲突／失效状态。
- 人格建议只写入当前实例身份草稿；内置建议不是已确认记忆或授权。
- 入口仅在读取成功、实例与内置包及版本匹配、无已存身份且所有草稿字段为空时出现。点击时重新核对编辑器状态；不自动应用或覆盖已有资料。

- [x] **Step 1: 写 UI 及编辑器测试**：复用已有直播绑定、授权、音色和学习回归；补空白身份载入各自建议、不覆盖已存身份或手填内容、读取复核、实例隔离及显式保存。
- [x] **Step 2: 运行 `pnpm exec tsx --test apps/workspace-ui/test/identity-editor.test.ts`**，确认新增三例因建议按钮和草稿应用缺失而失败。
- [x] **Step 3: 完成 UI 和文档**：同步空白身份入口与逐项授权边界，更新中英文 README 和专题指南，明确真实桌面仍待验。
- [x] **Step 4: 运行 UI 与角色合约定向测试及 `git diff --check`**：28 项通过，失败／跳过均为 0。
- [x] **Step 5: 运行 `pnpm run check:cross-platform`**：最终全量退出 0，1269 项通过，失败／跳过均为 0；桌面／OBS 未覆盖，见[实际验证记录](../../实际验证记录.md)。
- [x] **Step 6: 复核完整 staged/unstaged diff 和 `git status`**；身份建议改动不提交、不推送，等待用户后续明确指示。

## 调整后的执行检查点

1. **收口后端（当前）**：完成 Task 2 的删除／换包并发和存储失败验证；完成 Task 3 的候选／知识／过期／上下文大小拒绝测试；完成 Task 4 的服务路由、固定模型版本、绑定授权复核、AbortSignal 取消及音频票据测试。此检查点通过前不扩张角色素材链路。
2. **角色舞台**：执行 Task 5，鲸鱼妹只加载固定来源及哈希通过的 idle 和三种直播动作；首帧确认失败则不开放该角色互动，不借用龙妹素材。
3. **角色语音**：执行 Task 6，声音参考按实例隔离；无样本静音降级，不自动复用另一角色音色。
4. **显式学习**：执行 Task 7，仅对用户选中的单轮互动，经明确确认后提出一条偏好候选；普通弹幕和回复不写历史、不触发学习。
5. **界面与交付**：执行 Task 8，完成身份模板应用（已有内容不覆盖）、绑定／授权／音色／候选审核入口，更新相关指南、中英文 README、验证记录，随后跑 `pnpm run check:cross-platform` 与 `git diff --check`。
6. 自动化结果不替代真实 Electron、TTS 听感或 OBS 验收；本阶段不自动启动 Electron／OBS，不提交／推送。

## 完成条件

- 两角色 persona、实例绑定、授权、素材、布局、语音和 Pi 上下文全程实例隔离。
- 学习只能经用户单轮选择和明确确认产生待审核偏好；审核之前不进入模型后续上下文。
- 定向测试及完整 `pnpm run check:cross-platform` 均有本轮结果；真实 Electron、TTS 听感和 OBS 实播边界明确记录。
