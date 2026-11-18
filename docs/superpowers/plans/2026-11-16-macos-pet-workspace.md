# macOS 配置与桌宠工作区首批实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 提供可持久保存的隔离实例配置与新桌宠管理页面，不接管旧桌宠，不把配置登记当作真实运行。

**Architecture:** React 通过固定、有界的 preload 方法调用 Fastify 领域服务；TS 是配置唯一写入方。独立 workspace-state.json 保存 schema/revision/theme/registry，私有开发根不共享旧文件；Python 玩家桥保持原样。

**Tech Stack:** Node.js 24.x、pnpm 10.32.0、TypeScript、React/CSS、Electron、Fastify；不引入新业务依赖。

**Spec:** `docs/superpowers/specs/2026-11-16-macos-feature-migration-design.md`（2026-11-16 用户已确认进入实现）。

## Global Constraints

- Windows/Linux 播放器继续 blocked；先做 macOS 已有功能迁移。
- 不启动真实 Electron/Qt，不读真实旧资料/Keychain，不做账号/设备/付费请求，不构建/安装 .app，不改冻结 helper。
- 工作树含此前未提交基础：原地续作，保留其他改动，不创建提交/推送，不另建丢失未提交依赖的 worktree。
- 包管理只用 pnpm 10.32.0；新接口不得泄露路径/密钥或接受任意命令。
- 本批实例只登记配置，运行状态为 not-connected；独立诊断播放器不绑定这些实例。偏好展示“已保存，待应用”。
- 默认包目录为空；只有可信主进程显式配置开发播放器时，提供单一“龙妹开发配置”元数据引用，不伪造素材验证或导入成功。

## 任务 1：公开契约和旧格式兼容

文件：新增 `packages/contracts/src/pets.ts` 与对应 test，`apps/app-service/src/pet-registry.ts` 和 test。
接口：`WorkspaceData`（revision/theme/catalog/instances）、`PetResult`（固定错误码或 workspace），固定 `list/add/clone/delete/save/theme` 参数校验；`decodeRegistry(unknown)` 保留既有 ID/包引用与默认值，旧 size96–512 只在读取兼容时归一到128–384。

- [x] 写失败测试：严格字段、越界、重复 ID、32 项、默认偏好/克隆 autoStart、未知版本和旧尺寸；先运行确认红。
- [x] 实现类型与运行时校验、codec/纯领域操作；新写入只接受严格规范格式，不允许路径。
- [x] 跑定向测试/类型检查；验证编解码语义往返和受限命令边界。

## 任务 2：隔离存储与领域服务

文件：新增 `apps/app-service/src/pet-workspace.ts`、`workspace-store.ts` 及测试。
接口：`PetWorkspace.list()/mutate(action,input)/close()`；串行事务 + expectedRevision 乐观冲突检查；固定文件/128KiB限制、普通目录/文件和独占 writer lease，临时文件同步后 rename，失败原文件不变。关闭排空已有操作并拒绝新操作；崩溃残留 lease 不自动抢占，明确报 busy，人工恢复另行记录。

- [x] 写并运行失败测试：临时目录持久化/重开、并发冲突、克隆/删除/偏好、运行中拒删、损坏/未知版本/链接/过大文件拒绝、第二 writer 拒绝、失败不覆盖原文件。
- [x] 实现存储和业务错误码，不回传原始路径/异常；允许删除未连接的配置，不声称结束真实桌宠。
- [x] 跑定向测试；所有夹具在临时根，不使用旧资料。

## 任务 3：固定业务桥与服务集成

文件：server/entry/main/preload/service-process/security；新增固定业务路由/传输模块和测试，扩展 build smoke。
接口：`DesktopBridge.pets` 固定嵌套方法 `list/add/clone/delete/save/setTheme`；主 frame 身份与逐项 schema 校验后再转发。GET list 与五个固定 POST，服务端再次校验；受信父 IPC 传 workspace 根和元数据 catalog，页面不能选择路径。

- [x] 先测 HTTP/IPC 的认证/Origin/Host/未知字段/方法/参数/响应校验及持久化 smoke，确认缺失接口导致失败。
- [x] 实现受限传输/路由和关闭清理；不改变既有四个无参诊断/播放器动作。
- [x] 运行服务/desktop/构建回归；关闭仍回收自有进程，配置错误不显示假成功。

## 任务 4：新工作区、验证与文档

文件：workspace-ui 新 shell/桌宠页/组件/客户端/状态管理/style 与测试；保留运行诊断为高级页。README 中英文、迁移清单/专题/路线图/实际记录。
接口：配置请求的本地串行/操作代际防护、选中实例/编辑草稿、固定主题；服务端 revision 冲突保留草稿并提示刷新，不在错误时覆盖草稿。

- [x] 先写失败测试：桌宠首页、导航/空态、真实保存和未应用文案、删除确认、草稿/过时代际、错误安全、禁用未接入动作。
- [x] 实现暖灰/青绿主题、统一控件、实例列表/详情、登记/克隆/保存/删除、跟随系统/浅色/深色主题；其他页面明确尚未迁移，不堆假可用操作。
- [x] 运行 pnpm 全检查、项目检查、可行的合成离线 UI 渲染；不把 SSR/客户端逻辑测试叫真实视觉验收。
- [x] 申请只读代码审查并修复实质问题；同步真实证据与未执行边界，不提交。


## 实施与证据

2026-11-16 已实现上述 M1a 开发范围；不代表 M1b 运行控制、真实资料导入或 macOS 整体替代完成。最终 `pnpm run check:cross-platform` 121 项通过，项目检查33通过；合成 headless UI 检查覆盖保存/克隆/确认删除/登记/主题、窄窗口、固定侧栏与空目录。实际命令、审查修复、证据和未执行边界见[实际验证记录](../../实际验证记录.md)。本计划没有创建提交或启动真实 Electron/Qt。
