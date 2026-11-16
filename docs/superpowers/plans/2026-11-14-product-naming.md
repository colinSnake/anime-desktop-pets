# 通用层产品命名迁移计划

> 用户已确认：通用层去除 Dragon/dragon 命名，不提供旧标识兼容；用户自行重新构建及启动服务。龙妹专属实现与角色素材标识保留。

## 设计与边界

- Swift：`DragonCore` → `PetCore`，`DragonCompanion` → `PetCompanion`（源码、测试、导入、可执行产品）；Package → `AnimeDesktopPets`。
- Python通用模块：`dragon_instances.py` → `pet_instances.py`、`dragon_instance_ipc.py` → `pet_instance_ipc.py`、`dragon_pet_helper.py` → `pet_helper.py`。角色层 `bailong/dragon_*.py` 不变。
- 宿主 Bundle ID → `local.anime-desktop-pets.companion`，LaunchAgent → `local.anime-desktop-pets.companion.watch`；通用环境变量统一 `PET_*`；内部IPC及窗口控制标识使用产品名或 `pet-*`。
- helper自有来源元数据 → `PET_PATCH.json`、`PetPatchVersion`、`pet.44`；补丁模板和冻结输入检查同组迁移。角色来源包ID、固定上游哈希、第三方声明不更改。
- 数据仅使用 `AnimeDesktopPets`，不读取旧环境变量、不迁移旧目录、不创建兼容符号链接，也不删除用户旧目录。现有数据/应用/服务的人工处理在文档中说明。
- 保留现有未提交修改；不暂存、提交、安装、启动或结束真实进程。旧冻结app不能作为新源码可发布的证据，重建必须使用已审核本机字体。

## 执行顺序

1. 增加命名防回归测试，在旧实现上得到预期红灯；把数据目录测试改为新行为并先复现失败。
2. 使用文件移动保留工作区内容，迁移Swift模块、通用Python模块、引用和脚本；删除旧数据兼容分支。
3. 更新补丁新增行、helper版本/元数据、冻结输入清单、构建/安装/卸载/清理脚本。不要更改固定上游补丁上下文或第三方标识。
4. 同步中英文README、仓库指南、相关专题文档；历史验证记录原文不覆盖，追加本轮证据与破坏性变更说明。
5. 运行命名检查、Swift全量、构建输入和应用发布合成测试、Python运行时及多宠离线回归；仅生成必要的离线校验输入，不启动app。
6. 检查剩余dragon引用，区分角色实现、角色ID、第三方来源和历史记录；记录跳过、未执行和需要用户重建的边界。

## 验证入口

- `python3 scripts/test-product-naming.py`
- `swift test --package-path apps/companion-macos`
- `python3 scripts/check-project.py`
- `python3 scripts/test-app-bundle.py`
- `python3 scripts/test-pet-build-inputs.py`
- `./scripts/test-multi-pet.sh`
- 按运行时环境实际可用情况执行 `scripts/test-pet-runtime.py`、`scripts/test-real-pet-adapter.py`、`scripts/test-preview-pet-ui.py`、`scripts/test-qt-lifecycle.py`。
- `git diff --check`；不把跳过或已有旧包检查描述为通过。
