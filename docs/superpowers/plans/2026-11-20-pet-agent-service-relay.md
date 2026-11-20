# 桌宠 Agent：可信服务回合中转合成验收计划

> 历史计划：占位票据候选现已由 [Harness 文字执行链](2026-11-20-pet-agent-harness-text-turn.md) 替换。

延续[已确认方案](../specs/2026-11-20-pet-agent-workspace-design.md)与 macOS DSH 进程探针。此次只实现不接线的服务内候选，使用模拟 worker、临时工作区、自有合成凭证及注入的提供方传输。保持常规产品的 `sendOnlineChat`、路由、角色授权、返回协议和 UI 不变。

1. **先写服务验收。** 在 `apps/app-service/test/online-chat-dispatch.test.ts` 的临时工作区，覆盖模拟 worker 只能看到一次性票据与成功／失败回执、不同回合票据不可互换、实例占用与去重、真实保存连接修订/凭证轮换、授权撤回、确认前实例删除、取消及 worker 中止后的不确定结果。证明模拟 worker 不能注入模型/URL/工具、不能伪造用户聊天回复、不能导致回退或重发；先验证用例在缺少候选模块时失败。
2. **加不接线的候选模块。** `apps/app-service/src/agent/chat-turn-relay.ts` 由可信调用方持有，复制及验证既有回合，服务拥有路由、历史和角色资料；只给 worker 单回合、短时的随机令牌，不传正文或模型回复。同步核销令牌，再调用真实 `sendOnlineChat` 做现有复核；只接受服务自己观察到的回复。清理时撤销令牌，不把 worker 出错或失联推断为上游未收到。内存登记有硬上限且不驱逐已用请求 ID；不做持久回执或进程监管。
3. **复核。** 定向测试、类型检查、整套 `pnpm run check:cross-platform`、差异空白检查。单独复跑固定版本 DSH 进程探针（仅如本机依赖已安装），将其与不启动 SDK 的服务侧测试分开记录。更新中英文 README、验证指南及实际记录。此轮无界面改动，不启动桌面、不接真实 Key、不新增生产入口。
