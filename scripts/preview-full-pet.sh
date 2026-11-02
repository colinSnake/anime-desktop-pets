#!/usr/bin/env bash
# 用户主动运行的桌面预览入口。禁止在自动测试中调用；不会启动/重启 Codex。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ $# == 0 ]] || { echo 'Usage: ./scripts/preview-full-pet.sh' >&2; exit 2; }
CHECK="$("$ROOT/scripts/dragonctl.sh" --check)"
printf '%s' "$CHECK" | python3 -c '
import json,sys
result=json.load(sys.stdin)
if result.get("petBackend")!="external" or result.get("petActions") not in (25,35):
    raise SystemExit("当前不是完整 25/35 动作构建。请先准备资源、重新构建，并检查用户 companion.json 是否仍选择 native。")
'
STATE="$(python3 -c 'import os;from pathlib import Path;print(Path(os.environ.get("DRAGON_DATA_DIR","~/Library/Application Support/DragonCodexCompanion")).expanduser())')"
if [[ -S "$STATE/control.sock" ]]; then
  echo '退出当前伴侣实例后切换预览；不会退出 Codex。'
  "$ROOT/scripts/dragonctl.sh" --quit
  python3 - "$STATE/control.sock" <<'PY'
from pathlib import Path
import sys,time
path=Path(sys.argv[1]);end=time.monotonic()+8
while path.exists() and time.monotonic()<end:time.sleep(.1)
if path.exists():raise SystemExit('旧伴侣尚未退出，停止切换；请从其菜单栏退出后重试，不会强制结束进程。')
PY
fi
echo '启动完整动画桌宠预览。命令持续运行；从伴侣菜单栏退出，或在另一个终端运行 dragonctl.sh --quit。'
exec "$ROOT/scripts/dragonctl.sh" --preview-pet
