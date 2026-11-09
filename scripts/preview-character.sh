#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: ./scripts/preview-character.sh'
  echo 'Build and open an offline character window with a fresh temporary profile.'
  echo 'The profile is retained for restart/persistence checks; no pet helper or online service starts.'
  exit 0
fi
[[ $# -eq 0 ]] || { echo 'Use --help for usage.' >&2; exit 2; }
swift build --package-path "$ROOT/apps/companion-macos" --scratch-path "$ROOT/.build" --product DragonCompanion
CHARACTER_BIN_DIR="$(swift build --package-path "$ROOT/apps/companion-macos" --scratch-path "$ROOT/.build" --show-bin-path)"
CHARACTER_PREVIEW_DIR="$(mktemp -d "${TMPDIR:-/tmp}/adp-character-preview.XXXXXX")"
echo "Offline character preview data: $CHARACTER_PREVIEW_DIR"
echo "Executable: $CHARACTER_BIN_DIR/DragonCompanion"
echo 'Close with the red window button; the offline preview then exits normally.'
exec env DRAGON_DATA_DIR="$CHARACTER_PREVIEW_DIR" DRAGON_RESOURCE_DIR="$ROOT/resources" \
  "$CHARACTER_BIN_DIR/DragonCompanion" --preview-character-window
