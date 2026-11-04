#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
swift test --package-path "$ROOT/apps/companion-macos" --scratch-path "$ROOT/.build"
python3 "$ROOT/scripts/test-codex-tasks.py"
python3 "$ROOT/scripts/test-provider-quota.py"
python3 "$ROOT/scripts/test-startup-upscale.py"
python3 "$ROOT/scripts/check-project.py"
python3 "$ROOT/scripts/test-app-icon.py"
python3 "$ROOT/scripts/test-pet-build-inputs.py"
python3 "$ROOT/scripts/test-full-pet.py"
python3 "$ROOT/scripts/test-extra-animations.py"
if [[ -x "$ROOT/.local/pet-build/venv/bin/python" ]]; then
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
    "$ROOT/.local/pet-build/venv/bin/python" "$ROOT/scripts/test-pet-library.py"
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
    "$ROOT/.local/pet-build/venv/bin/python" "$ROOT/scripts/test-pet-library-ui.py"
else
  python3 "$ROOT/scripts/test-pet-library.py"
  echo 'Pet library UI tests skipped: prepared PySide6 runtime is unavailable.'
fi
if [[ -x "$ROOT/.local/pet-build/venv/bin/python" && -f "$ROOT/.local/pet-build/generated-source/DRAGON_PATCH.json" ]]; then
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
    "$ROOT/.local/pet-build/venv/bin/python" "$ROOT/scripts/test-pet-runtime.py"
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
    "$ROOT/.local/pet-build/venv/bin/python" "$ROOT/scripts/test-preview-pet-ui.py"
else
  echo 'Enhanced runtime tests skipped: prepare the private source build first.'
fi
if [[ -x "$ROOT/build/Dragon Codex Companion.app/Contents/MacOS/DragonCompanion" ]]; then
  python3 "$ROOT/scripts/test-control.py"
fi

if [[ -x "$ROOT/.local/pet-build/venv/bin/python" && -f "$ROOT/.local/pet-build/generated-source/DRAGON_PATCH.json" ]]; then
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
    "$ROOT/.local/pet-build/venv/bin/python" "$ROOT/scripts/test-real-pet-adapter.py"
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
    "$ROOT/.local/pet-build/venv/bin/python" "$ROOT/scripts/test-qt-lifecycle.py"
fi
