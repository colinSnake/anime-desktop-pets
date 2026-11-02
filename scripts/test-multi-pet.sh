#!/usr/bin/env bash
# 新增MP1离线入口，独立scratch，不占用另一个会话的正式构建目录。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${DRAGON_MULTI_PET_PYTHON:-$ROOT/.local/pet-build/venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  echo 'Missing prepared Python/PySide6/Pillow runtime; no automatic download or partial-pass claim.' >&2
  exit 1
fi
swift test --package-path "$ROOT/apps/companion-macos" --scratch-path "$ROOT/.local/multi-pet-validation/swift-build"
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  "$PYTHON" "$ROOT/scripts/test-multi-pet.py"
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  "$PYTHON" "$ROOT/scripts/test-real-pet-adapter.py"
# 拒绝IP联网，但允许本机Unix socket；所有fixture使用临时HOME与profile。
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (deny network-inbound (local ip "*:*"))' \
  "$PYTHON" "$ROOT/scripts/test-instance-ipc.py"
python3 "$ROOT/scripts/test-pet-build-inputs.py"
