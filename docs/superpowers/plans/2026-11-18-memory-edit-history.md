# 按实例编辑记忆与恢复历史实施计划

**目标：** 在现有记忆页编辑当前资料，按条目预览历史，并可将所选版本恢复为待确认的新版本。

**架构：** 复用实例注册队列、角色原子仓库与全局修订；保存沿用条目 ID，实际修改或恢复后须重新审核，等值编辑保留原状态。普通列表保持只返回当前条目。按需历史投影带实例、条目与修订，最多五条。现有个人记忆／角色知识页面使用共享表单和内联操作。

**技术栈：** Node.js 24、pnpm 10.32.0、TypeScript、Fastify、Electron、React。以前置[本机角色仓库](2026-11-18-character-local-storage.md)、[手动审核与目标进度](2026-11-18-character-memory-goals.md)及[迁移清单 C04](../../macOS功能迁移清单.md)为基线。

- [x] 在 `apps/app-service/test/character-routes.test.ts` 和 `apps/desktop/test/character-transport.test.ts` 添加失败回归：拒绝错实例／条目、额外字段与旧修订；验证等值提交、五条历史、新版本待确认、删除后拒绝和传输失败保守处理。先用 `pnpm exec tsx --test` 运行这两个文件确认失败。
- [x] 在 `packages/contracts/src/character-records.ts` 加 `readMemoryHistory({ petID, id })`、`editMemory({ petID, id, expectedRevision, draft })`、`restoreMemory({ petID, id, expectedRevision, historicalRevision })`。历史 GET 固定路径，读响应严格绑定请求，写响应沿用现有契约。在 `apps/app-service/src/characters/record-routes.ts`、`apps/desktop/src/{character-transport,preload}.ts` 接入，复用既有主进程与生命周期门禁；在构建冒烟检查固定桥。重跑定向测试。
- [x] 在 `apps/workspace-ui/test/character-record-editor.test.ts` 先覆盖草稿冲突、实例删除时迟到历史、显式恢复和内联界面。接 `apps/workspace-ui/src/pages/{character-record-editors,MemoryPage}`：同实例一次编辑一条，新增草稿保留；读取和写入有明确状态，不使用应用内弹窗；恢复前先显示该版本，编辑草稿存在时禁止恢复。重跑定向测试。
- [x] 运行跨平台检查、可信 Qt/Fusion/offscreen 合成回归、项目和差异检查。同步中英文 README、开发说明、迁移清单、路线图、交接和实际验证记录。仅临时目录及合成数据；不启动真实桌面、不导入、不分享、不接新服务、不修改冻结 helper、不提交或推送。

实际命令与边界见[本批验证](../../实际验证记录.md)。
