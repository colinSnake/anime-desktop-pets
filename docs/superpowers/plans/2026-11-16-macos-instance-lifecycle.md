# macOS 逐实例开发播放器生命周期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已确认的 macOS 优先迁移方向下，为登记实例接通显式启动/停止及真实运行阶段，不提前声称偏好、素材导入或多端播放器完成。

**Architecture:** Fastify 工作区作为唯一配置写入者，并拥有独立的实例生命周期协调器。仅将可信父进程显式配置的开发角色映射到新建 PlayerRuntime；每次启动保留原有随机隔离会话，绝不关联旧进程。运行状态不持久化、不增加配置修订；异步启动/停止立即返回阶段，由固定 list 刷新确认，避免长启动堵塞取消。

**Tech Stack:** TypeScript / React / Fastify / 既有 Python stdio 播放器；pnpm 10.32.0、Node.js 24.x。

**Spec:** `../specs/2026-11-16-macos-feature-migration-design.md`；`../../macOS功能迁移清单.md` M1b。

**Execution Evidence:** 本轮实际命令与边界记于 `../../实际验证记录.md` 的 2026-11-16 M1b 条目；计划完成不表示真实 Electron/Qt 桌面验收通过。

## Global Constraints

- 仅 macOS + 显式开发配置；Windows/Linux blocked 不变，不自动启动/恢复，不接管旧桌宠。
- 开发元数据不是已验证素材包身份；源路径只来自主进程，renderer 无路径/命令/环境输入。
- 每实例只控制自己创建的运行时；最多同时占用 3 个槽，失败/退出未确认保守占槽和阻止删除。
- 所有偏好仍仅保存待应用；启动不声称采用保存的大小、位置或活动设置。
- 不修改 Python/Qt/frozen helper，不打开真实 Electron/Qt，不提交、不安装。

### Task 1: 实例生命周期领域和服务装配

Files: 新建 `apps/app-service/src/pet-lifecycle.ts` 及其测试；修改 `pet-workspace.ts`、`entry.ts`、`pet-routes.ts`、`packages/contracts/src/pets.ts`。

- [x] 先写失败测试：无自动运行、关联白名单、3 槽并发、启动取消、失败保守态、逐实例隔离、关闭全量清理、关闭后拒绝。
- [x] 用注入的 `PlayerController` 工厂实现生命周期；真实工厂仅可信父进程装配，复用现有首帧/退出确认。
- [x] 增加固定 start/stop 输入，复用 revision 校验但不写磁盘；删除必须停止确认，删除后释放控制器引用。
- [x] 运行领域、服务与合约测试，确认原来的配置写入行为保留。

### Task 2: 安全桥接与页面运行控制

Files: `apps/desktop/src/{main,preload,pet-ipc,pet-transport}.ts`；`apps/workspace-ui/src/{pet-state,PetPage,App}.tsx/ts` 及测试。

- [x] 先写失败测试：严格参数数量/白名单、失败和过时响应不覆盖草稿、运行阶段刷新。
- [x] 添加仅按实例 ID 的 start/stop 固定桥接；不公开工厂或文件路径。
- [x] 页面增加启动/停止、取消启动、真实阶段展示和有界可见状态刷新；保留草稿，停止后才允许删除。
- [x] 明确开发播放与偏好待应用的区别，不使用假“已应用”。

### Task 3: 验证与文档

- [x] 运行 `pnpm run check:cross-platform`、`python3 scripts/check-project.py` 和差异空白检查。
- [x] 使用可信本机 Qt/Fusion/offscreen 合成回归验证复用的播放器入口（不作为真实桌面验收）。
- [x] 更新中英文 README、迁移清单、开发文档、路线图、AGENTS、实际验证记录，分别记录测试和未验收项。
- [x] 审查进程所有权、取消时序、关闭失败、跨层白名单和文案；不创建提交。
