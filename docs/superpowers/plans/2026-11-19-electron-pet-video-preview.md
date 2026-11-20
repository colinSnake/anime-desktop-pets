# Electron 透明视频桌宠第一阶段 Implementation Plan

> 按测试优先在当前迁移工作树增加独立预览，不打包或提交第三方素材。

**Goal:** 提供待机、拖拽松手和工作切回待机的透明 WebM 桌面验证入口。

**Architecture:** 独立 Electron 进程消费固定归档中四段原片；只在临时目录构建。主进程拥有窗口和位置，双视频渲染端负责首帧确认及 Alpha 点击命中。

**Tech Stack:** Electron、TypeScript、esbuild、Node 24、Python 标准库。

**Spec:** [第一阶段设计](../specs/2026-11-19-electron-pet-video-preview-design.md)

- [x] 先测试 `video-preview/motion.ts` 的轻放、甩动和显示边界，以及 `video-preview/playback.ts` 的提交/取消/结束；实现可独立离线运行的两个模块。
- [x] 先测试 `video-preview/media.ts` 的固定路由及单段 Range，后实现流媒体；测试归档输入的缺失、散列不符及提取固定四段。
- [x] 新增预览专用 main/preload/renderer、静态页和 `scripts/run-pet-video-preview.mjs`，不接主工作区服务；构建冒烟检查三入口可打包，不启动 Electron。
- [x] 更新中英文入口、开发指南和实际验证记录，记录运行命令和仍待人工验证的桌面边界。
