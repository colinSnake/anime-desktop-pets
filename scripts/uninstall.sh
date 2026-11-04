#!/usr/bin/env bash
set -euo pipefail
LABEL='local.dragon.codex-companion.watch'
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/桌边小崽.app"
LEGACY_APP="$HOME/Applications/Dragon Codex Companion.app"
[[ $# == 0 || ( $# == 1 && ( "$1" == --confirm || "$1" == --dry-run ) ) ]] || { echo 'Usage: uninstall.sh [--dry-run | --confirm]' >&2; exit 2; }
if [[ "${1:-}" != --confirm ]]; then
  printf 'Dry run only. --confirm stops our watcher and moves owned installed apps to Trash:\n  %s\n  %s (legacy, if present)\nSettings and official Codex remain unchanged.\n' "$APP" "$LEGACY_APP"
  exit 0
fi
# Validate both names before stopping a service or moving either bundle.
for candidate in "$APP" "$LEGACY_APP"; do
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    [[ ! -L "$candidate" ]] || { echo 'Refusing symlink App.' >&2; exit 1; }
    ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate/Contents/Info.plist" 2>/dev/null || true)
    [[ "$ID" == local.dragon.codex-companion ]] || { echo 'Refusing to touch unrelated App.' >&2; exit 1; }
  fi
done
if [[ -e "$AGENT" || -L "$AGENT" ]]; then
  [[ ! -L "$AGENT" ]] || { echo 'Refusing symlink LaunchAgent.' >&2; exit 1; }
  ID=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$AGENT" 2>/dev/null || true)
  EXE=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$AGENT" 2>/dev/null || true)
  [[ "$ID" == "$LABEL" && ( "$EXE" == "$APP/Contents/MacOS/DragonCompanion" || "$EXE" == "$LEGACY_APP/Contents/MacOS/DragonCompanion" ) ]] || { echo 'LaunchAgent ownership mismatch; stopped.' >&2; exit 1; }
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL" || { echo 'Watcher stop failed; preserving app and agent.' >&2; exit 1; }
  fi
  /bin/rm "$AGENT"
fi
for candidate in "$APP" "$LEGACY_APP"; do
  if [[ -e "$candidate" ]]; then
    mkdir -p "$HOME/.Trash"
    mv "$candidate" "$HOME/.Trash/$(basename "$candidate" .app).$(date +%Y%m%d-%H%M%S)-$$.app"
  fi
done
echo 'Our installed integration removed. User settings, local media, other themes and official Codex were preserved.'
