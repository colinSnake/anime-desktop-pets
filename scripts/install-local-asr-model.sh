#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOICE_ROOT="$ROOT/.local/voice-runtime"
SOURCE="$VOICE_ROOT/models/Qwen3-ASR-0.6B-modelscope"
OUTPUT="$VOICE_ROOT/models/Qwen3-ASR-0.6B-8bit"
REVISION="4ce9cc728b473a5aedbe7b6e1ea45646316824dc"
REPOSITORY="https://www.modelscope.cn/Qwen/Qwen3-ASR-0.6B.git"
PYTHON="$VOICE_ROOT/venv/bin/python"

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
  echo 'Local MLX ASR setup requires Apple Silicon macOS.' >&2
  exit 1
}
[[ -x "$PYTHON" ]] || { echo "Missing voice runtime: $PYTHON" >&2; exit 1; }
command -v git-lfs >/dev/null || { echo 'git-lfs is required for the ModelScope snapshot.' >&2; exit 1; }
available_kib="$(df -Pk "$ROOT" | awk 'NR == 2 {print $4}')"
(( available_kib >= 6 * 1024 * 1024 )) || {
  echo 'At least 6 GiB free space is required; no files were removed.' >&2
  exit 1
}

mkdir -p "$VOICE_ROOT/models"
if [[ -d "$OUTPUT" ]]; then
  echo "Local ASR model is already installed; keeping the converted model and skipping the source download: $OUTPUT"
  exit 0
fi
if [[ -d "$SOURCE/.git" ]]; then
  current="$(git -C "$SOURCE" rev-parse HEAD)"
  [[ "$current" == "$REVISION" ]] || {
    echo "Existing source checkout is not the pinned revision: $current" >&2
    exit 1
  }
else
  [[ ! -e "$SOURCE" ]] || { echo "Refusing to overwrite existing path: $SOURCE" >&2; exit 1; }
  git clone --no-checkout "$REPOSITORY" "$SOURCE"
  git -C "$SOURCE" checkout --detach "$REVISION"
fi
git -C "$SOURCE" lfs pull

"$PYTHON" -m mlx_audio.convert \
  --hf-path "$SOURCE" \
  --mlx-path "$OUTPUT" \
  --model-domain stt \
  --quantize --q-bits 8 --q-group-size 64 --dtype bfloat16

echo "Installed local ASR model from ModelScope revision $REVISION: $OUTPUT"
