#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="${DRAGON_THEME_ENGINE_HOME:-$HOME/.codex/skills/codex-theme-studio}"
ACTION="${1:-help}"
case "$ACTION" in
  help)
    echo 'Optional experimental theme workflow (never changes app.asar):'
    echo '  ./scripts/theme.sh compile [absolute-art-path]'
    echo '  ./scripts/theme.sh apply --confirm'
    echo '  ./scripts/theme.sh restore --confirm'
    echo 'Requires installed codex-theme-studio and reviewed original artwork.'
    exit 0 ;;
  compile|apply|restore) ;;
  *) echo 'Unknown theme action.' >&2; exit 2 ;;
esac
[[ -f "$ENGINE/scripts/compile-theme.mjs" ]] || { echo 'codex-theme-studio is not installed; no changes made.' >&2; exit 1; }
case "$ACTION" in
  compile)
    ART="${2:-$ROOT/resources/poster/home-background.png}"
    [[ -s "$ART" ]] || { echo 'Original poster is not ready. Generate/review it first; no theme was compiled.' >&2; exit 1; }
    mkdir -p "$ROOT/build/theme"
    node "$ENGINE/scripts/compile-theme.mjs" --brief "$ROOT/theme/brief.json" --art "$ART" --output-root "$ROOT/build/theme" | tee "$ROOT/build/theme/compile-result.json"
    ;;
  apply)
    [[ "${2:-}" == --confirm ]] || { echo 'Explicit --confirm required; may launch official Codex with loopback CDP. Never auto-restarts an existing client.' >&2; exit 2; }
    [[ -f "$ROOT/build/theme/compile-result.json" ]] || { echo 'Compile the theme first.' >&2; exit 1; }
    MANIFEST="$(python3 - "$ROOT/build/theme/compile-result.json" <<'PYCODE'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); manifest=Path(json.loads(p.read_text())['manifestPath']).resolve()
if not manifest.is_relative_to(p.parent.resolve()): raise SystemExit('Manifest escaped the build directory')
print(manifest)
PYCODE
)"
    [[ -n "$MANIFEST" && -f "$MANIFEST" ]] || { echo 'Compile the theme first.' >&2; exit 1; }
    node "$ENGINE/scripts/start-theme.mjs" --theme "$MANIFEST"
    ;;
  restore)
    [[ "${2:-}" == --confirm ]] || { echo 'Explicit --confirm required.' >&2; exit 2; }
    STATE="$HOME/Library/Application Support/CodexThemeStudio/state.json"
    [[ -f "$STATE" ]] || { echo 'No active theme state; nothing changed.'; exit 0; }
    python3 - "$STATE" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
if p.exists() and json.loads(p.read_text()).get('theme')!='dragon-moonlight':
    raise SystemExit('Another theme owns the runtime; refusing to remove it.')
PY
    node "$ENGINE/scripts/restore-theme.mjs"
    ;;
esac
