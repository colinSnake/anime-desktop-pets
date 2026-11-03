# Anime Desktop Pets

[English](README.md) | [简体中文](README.zh.md)

面向 macOS 的动漫风格桌宠项目。当前角色是 Codex 白龙；Claude、DeepSeek、Grok 角色仍属规划，尚未接入。
桌边小伙伴应用与 Codex 并行运行，不修改官方应用包或 `app.asar`。本项目不是 OpenAI 产品，也不是官方插件。

应用界面称呼为 **「桌边小伙伴」**，配文 **「让喜欢的角色，陪在桌边。」**。项目展示名为 Anime Desktop Pets；
现有应用包名、配置标识和数据路径保持不变。

## 当前状态

本项目是本地开发原型，提供 **35个角色动作**、多宠管理和本地素材库。
完整动画由独立 helper 提供，Swift 原生 PNG 后端仅为有限降级方案。尚未接入 Codex 现有任务状态跟随；真实桌面行为、
焦点、多屏和长期资源表现仍待人工验收。详见[路线图](docs/roadmap.md)与[实际验证记录](docs/实际验证记录.md)。

## 环境要求

- Apple Silicon Mac，macOS 13 或更新版本；目前以本机 arm64 构建为验证对象。
- Xcode Command Line Tools（Swift 5.9 或更新版本）及用于构建/测试脚本的 Python 3。
- 如需 Codex 联动，需安装 Codex 桌面应用。
- 全新检出需自行准备有权使用的本地媒体和桌宠素材；这些私有资源不随 Git 仓库分发。

## 构建与检查

在仓库根目录执行。先按[本地开发指南](docs/本地开发与使用指南.md)导入媒体，
再按[桌宠构建说明](docs/桌宠增强与性能构建.md)准备固定上游应用、专用 Python 环境和本地动作素材。

```bash
python3 scripts/prepare-full-pet.py fetch
python3 scripts/build-pet-runtime.py build
./scripts/build.sh
./scripts/test.sh
./scripts/dragonctl.sh --check
```

默认 helper 引用本机动作素材，不是可移植发行包。构建与测试命令不会启动桌宠或重启 Codex；`--check` 只检查配置和资源，
不等于真实桌面验收。

需要主动预览完整桌宠时运行 `./scripts/preview-full-pet.sh`。该入口切换模式前可能退出现有桌宠实例；需要保留正在运行的实例时不要运行。
Codex 启动/观察模式和本地配置见[本地使用指南](docs/本地开发与使用指南.md)。

## 功能与边界

- 提供完整动画白龙桌宠、多实例管理和本地素材库。
- macOS 宿主负责启动呈现与生命周期协调；独立 Python/PySide6 helper 负责动画和交互。
- Codex 额度仅在用户主动请求时，通过现有只读本地适配器刷新。
- 不提供桌宠自有聊天或历史，不读取聊天正文，也不跟随现有 Codex 任务状态。
- 海报生成及自动应用主题尚未启用。

技术实现、动作素材、接口与版本迭代细节统一维护在[文档索引](docs/文档索引.md)，不在项目入口重复展开。

## 验证

`./scripts/test.sh` 运行项目测试；专用环境已准备时，可用 `./scripts/test-multi-pet.sh` 运行多宠与 IPC 独立测试。
有测试套件跳过时不能报告为完整通过。自动化和离屏测试不等于真实桌面验收；范围与未完成项见[验证记录](docs/实际验证记录.md)。

## 文档

- [本地开发、使用、配置与安装](docs/本地开发与使用指南.md)
- [架构与设计](docs/架构与设计决策.md)、[运行时构建与性能](docs/桌宠增强与性能构建.md)
- [开发路线图](docs/roadmap.md)、[版本与实际验证记录](docs/实际验证记录.md)
- [完整文档索引](docs/文档索引.md)
- [Git 提交规范](docs/Git提交与协作规范.md)

## 许可

根目录 [MIT 许可证](LICENSE)仅覆盖本项目原创源码，不授予第三方角色、动画、视频、音乐或商标的权利。
确认授权允许前，不得分发含第三方素材的构建。详见[第三方说明](THIRD_PARTY_NOTICES.md)及 `licenses/`。
