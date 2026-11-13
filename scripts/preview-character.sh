#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: ./scripts/preview-character.sh'
  echo 'Build and open the offline management workspace with a fresh temporary profile.'
  echo 'The profile is retained for restart/persistence checks; no pet helper or online service starts.'
  exit 0
fi
[[ $# -eq 0 ]] || { echo 'Use --help for usage.' >&2; exit 2; }
WORKSPACE_SCRATCH="${DRAGON_SWIFT_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/adp-workspace-build.XXXXXX")}"
swift build --package-path "$ROOT/apps/companion-macos" --scratch-path "$WORKSPACE_SCRATCH" --product DragonCompanion
WORKSPACE_BIN_DIR="$(swift build --package-path "$ROOT/apps/companion-macos" --scratch-path "$WORKSPACE_SCRATCH" --show-bin-path)"
WORKSPACE_PREVIEW_DIR="$(mktemp -d "${TMPDIR:-/tmp}/adp-workspace-preview.XXXXXX")"
echo "Offline workspace preview data: $WORKSPACE_PREVIEW_DIR"
echo "Executable: $WORKSPACE_BIN_DIR/DragonCompanion"
echo 'Close with the red window button; the offline preview then exits normally.'
exec env DRAGON_DATA_DIR="$WORKSPACE_PREVIEW_DIR" DRAGON_RESOURCE_DIR="$ROOT/resources" \
  "$WORKSPACE_BIN_DIR/DragonCompanion" --preview-character-window
