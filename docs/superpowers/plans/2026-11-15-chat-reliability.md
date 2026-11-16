# 聊天可靠性 Implementation Plan

> 按用户已确认设计在当前工作区顺序实施；不使用子代理，不自动提交。

**Goal:** 完整文字回复、可停止/重试的请求，以及带手工降级的模型发现。
**Architecture:** 保留 SwiftUI 页面与 Coordinator 本地优先路由；分离回复用途、抽取请求生命周期及模型发现职责，所有网络通过现有 URLSession 注入测试。
**Tech Stack:** Swift 5.9、SwiftUI/AppKit、Foundation URLSession、XCTest。
**Spec:** `docs/superpowers/specs/2026-11-15-chat-reliability-design.md`

## Global Constraints
- macOS 13+；保留其他未提交改动；不读取真实配置/Keychain、不使用真实模型请求。
- 不创建 `.app`、不安装或启动、不提交推送。中英文 README、专题、验证记录同步。

### Task 1: 回复用途与完整展示
- [ ] 增加 URLProtocol 的文字完整性、无工具降级、上下文预算测试，先运行确认失败。
- [ ] ModelProvider 按用途独立提示/预算；ChatProvider 选择文字用途，语音保持短句；会话展示与出站历史预算分离。
- [ ] 运行相关 Provider/Core/UI 回归。

### Task 2: 聊天请求生命周期
- [ ] 增加停止后迟到响应、重试历史/消息标识、空回复、草稿及长期资料边界测试，确认失败。
- [ ] 从 WorkspaceModel 抽取窄范围聊天扩展，实现带请求标识的取消、重试、独立状态；原生按钮展示停止/重试与恢复草稿。
- [ ] 运行聊天键盘、滚动及新状态回归，复测已存在输入修复。

### Task 3: 模型发现
- [ ] 增加发现接口解析、URL、错误/重定向边界、服务变更隔离测试，确认失败。
- [ ] 新建模型发现客户端；模型管理及聊天原生弹窗提供明确刷新入口，保留手工列表与当前对话。
- [ ] 运行模型选择/发现/离线预览回归。

### Task 4: 集成与交付检查
- [ ] 更新 README.md / README.zh.md / 管理工作区界面 / 实际验证记录。
- [ ] 运行全量 Swift、项目检查、Release 产品编译、diff 检查；检查无真实网络/Keychain副作用。
- [ ] 汇报本轮实际结果与未打包/未实机验收边界，不使用历史结果冒充本轮。
