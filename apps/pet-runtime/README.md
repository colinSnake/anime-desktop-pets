# Python 桌宠运行时

本目录保存 Python/PySide6 桌宠辅助应用的业务源码，当前仍通过固定上游源码和 PyInstaller 生成 helper，
不是一个已经可以独立 `pip install` 的发布包。

- `bailong/`：龙妹播放、帧缓存、行为、UI 和呈现时钟增强。
- 待机问候复用现有桌面气泡，延迟出现并低频轮换；任务、交互、隐藏和减少动态效果状态优先。用户交互后延长自主动作等待、偏向待机动作，并推迟问候；安静时段仍通过洗牌队列覆盖互动与待机动作。
- 用户甩动后的跑/飞素材与松手物理轨迹同步循环；轨迹收敛后锁定窗口位置并额外保留2秒，再独立回到待机，不改变自主动作调度计时。用户接管、任务跟随或减少动态效果仍可提前结束。
- `pets/`：多实例生命周期、控制 IPC、素材包校验和引用锁；不提供独立素材库窗口；`pet_sources.py` 为宿主内置桌宠管理提供无窗口目录扫描、校验与多选导入，`add_pets` 登记后保持停止。

固定上游清单、来源说明和补丁位于根目录 `integrations/bailong/`。
根 `scripts/build-pet-runtime.py` 将这里的模块复制到私有生成源码目录，再冻结 helper；
不要编辑生成目录或参考仓库。修改业务源码后，先重建 helper，再重建宿主。
在仓库根目录执行：

```sh
python3 scripts/build-pet-runtime.py build \
  --source-revision 8e5466d9a438deb6cb43f460e7f5a9bdb9d7a578
./scripts/build.sh --enhanced-pet
./scripts/test.sh
./scripts/test-multi-pet.sh
```

PySide6 测试须使用 `.local/pet-build/venv/` 专用环境，根 shell 测试入口会选用该环境；
没有依赖时的跳过不能算完整通过。数据、素材与专用环境不随源码迁移。
