#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/build/Dragon Codex Companion.app"
DEST="$HOME/Applications/Dragon Codex Companion.app"
LABEL='local.dragon.codex-companion.watch'
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
if [[ "${1:-}" != --confirm ]]; then
  printf 'Dry run only. Would install:\n  %s\n  %s\nRun with --confirm after manual acceptance.\n' "$DEST" "$AGENT"
  exit 0
fi
[[ $# == 1 ]] || { echo 'Unknown install arguments.' >&2; exit 2; }
[[ -x "$SOURCE/Contents/MacOS/DragonCompanion" ]] || { echo 'Build first.' >&2; exit 1; }
codesign --verify --deep --strict "$SOURCE"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo 'Existing Dragon service is loaded. Stop/uninstall it explicitly before upgrading.' >&2; exit 1
fi
for legacy in 'community.dragoncodexboot.codex-watcher' 'local.bailongpet.macos.autostart' 'io.github.wunsch2048.bailong-enhanced.codex-sync'; do
  if [[ -f "$HOME/Library/LaunchAgents/$legacy.plist" ]] || launchctl print "$DOMAIN/$legacy" >/dev/null 2>&1; then
    echo "Conflicting watcher found: $legacy. Disable it with its own uninstall command first." >&2; exit 1
  fi
done
if [[ -e "$DEST" ]]; then
  ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$DEST/Contents/Info.plist" 2>/dev/null || true)
  [[ "$ID" == local.dragon.codex-companion ]] || { echo 'Refusing to replace unrelated App.' >&2; exit 1; }
fi
if [[ -f "$AGENT" ]]; then
  ID=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$AGENT" 2>/dev/null || true)
  [[ "$ID" == "$LABEL" ]] || { echo 'Refusing to replace unrelated LaunchAgent.' >&2; exit 1; }
fi
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents" "$HOME/Library/Application Support/DragonCodexCompanion"
if [[ -e "$DEST" ]]; then mv "$DEST" "$DEST.previous.$(date +%Y%m%d-%H%M%S)-$$"; fi
ditto "$SOURCE" "$DEST"
python3 - "$AGENT" "$DEST/Contents/MacOS/DragonCompanion" "$LABEL" <<'PY'
import plistlib,sys
from pathlib import Path
path,exe,label=sys.argv[1:]
root=Path.home()/'Library/Application Support/DragonCodexCompanion'
with open(path,'wb') as f:
    plistlib.dump(dict(Label=label,ProgramArguments=[exe,'--watch'],RunAtLoad=True,
        LimitLoadToSessionType='Aqua',ProcessType='Background',
        StandardOutPath=str(root/'service.out.log'),StandardErrorPath=str(root/'service.err.log')),f)
PY
launchctl bootstrap "$DOMAIN" "$AGENT"
printf 'Installed watcher. Existing Codex is not restarted; existing sessions do not replay the movie.\n'
