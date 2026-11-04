#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/build/桌边小崽.app"
DEST="$HOME/Applications/桌边小崽.app"
LEGACY_DEST="$HOME/Applications/Dragon Codex Companion.app"
LABEL='local.dragon.codex-companion.watch'
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
[[ $# == 0 || ( $# == 1 && ( "$1" == --confirm || "$1" == --dry-run ) ) ]] || { echo 'Usage: install.sh [--dry-run | --confirm]' >&2; exit 2; }
if [[ "${1:-}" != --confirm ]]; then
  printf 'Dry run only. Would install:\n  %s\n  %s\nAn owned legacy app at %s would be archived, not duplicated.\nRun with --confirm after manual acceptance.\n' "$DEST" "$AGENT" "$LEGACY_DEST"
  exit 0
fi
[[ -x "$SOURCE/Contents/MacOS/DragonCompanion" ]] || { echo 'Build first.' >&2; exit 1; }
codesign --verify --deep --strict "$SOURCE"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo 'Existing service is loaded. Stop/uninstall it explicitly before upgrading.' >&2; exit 1
fi
for legacy in 'community.dragoncodexboot.codex-watcher' 'local.bailongpet.macos.autostart' 'io.github.wunsch2048.bailong-enhanced.codex-sync'; do
  if [[ -f "$HOME/Library/LaunchAgents/$legacy.plist" ]] || launchctl print "$DOMAIN/$legacy" >/dev/null 2>&1; then
    echo "Conflicting watcher found: $legacy. Disable it with its own uninstall command first." >&2; exit 1
  fi
done
if [[ -e "$AGENT" || -L "$AGENT" ]]; then
  [[ ! -L "$AGENT" ]] || { echo 'Refusing symlink LaunchAgent.' >&2; exit 1; }
  ID=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$AGENT" 2>/dev/null || true)
  EXE=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$AGENT" 2>/dev/null || true)
  [[ "$ID" == "$LABEL" && ( "$EXE" == "$DEST/Contents/MacOS/DragonCompanion" || "$EXE" == "$LEGACY_DEST/Contents/MacOS/DragonCompanion" ) ]] || { echo 'LaunchAgent ownership mismatch; stopped.' >&2; exit 1; }
fi
mkdir -p "$HOME/Applications"
STAGING="$(mktemp -d "$HOME/Applications/.desk-cub-install.XXXXXX")"
trap 'test ! -d "$STAGING" || /bin/rm -rf "$STAGING"' EXIT
ditto "$SOURCE" "$STAGING/桌边小崽.app"
codesign --verify --deep --strict "$STAGING/桌边小崽.app"
# Same guarded publisher as local builds: rejects unrelated/symlink bundles and restores failed moves.
python3 "$ROOT/scripts/publish-app-bundle.py" --bundle "$STAGING/桌边小崽.app" --build-dir "$HOME/Applications"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Application Support/DragonCodexCompanion"
python3 - "$AGENT" "$DEST/Contents/MacOS/DragonCompanion" "$LABEL" <<'PY'
import os,plistlib,sys
from pathlib import Path
path,exe,label=sys.argv[1:]
root=Path.home()/'Library/Application Support/DragonCodexCompanion'
temporary=Path(path).with_name(Path(path).name+f'.tmp.{os.getpid()}')
try:
    with temporary.open('xb') as f:
        plistlib.dump(dict(Label=label,ProgramArguments=[exe,'--watch'],RunAtLoad=True,
            LimitLoadToSessionType='Aqua',ProcessType='Background',
            StandardOutPath=str(root/'service.out.log'),StandardErrorPath=str(root/'service.err.log')),f)
    os.replace(temporary,path)
finally:
    temporary.unlink(missing_ok=True)
PY
launchctl bootstrap "$DOMAIN" "$AGENT"
printf 'Installed 桌边小崽 watcher. Existing Codex is not restarted; existing sessions do not replay the movie.\n'
