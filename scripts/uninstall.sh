#!/usr/bin/env bash
set -euo pipefail
LABEL='local.dragon.codex-companion.watch'
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/桌边小崽.app"
[[ $# == 0 || ( $# == 1 && ( "$1" == --confirm || "$1" == --dry-run ) ) ]] || { echo 'Usage: uninstall.sh [--dry-run | --confirm]' >&2; exit 2; }
if [[ "${1:-}" != --confirm ]]; then
  printf 'Dry run only. --confirm stops our watcher and moves the owned app to Trash:\n  %s\nSettings and official Codex remain unchanged.\n' "$APP"
  exit 0
fi
if [[ -e "$APP" || -L "$APP" ]]; then
  [[ ! -L "$APP" ]] || { echo 'Refusing symlink App.' >&2; exit 1; }
  ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)
  [[ "$ID" == local.dragon.codex-companion ]] || { echo 'Refusing to touch unrelated App.' >&2; exit 1; }
fi
if [[ -e "$AGENT" || -L "$AGENT" ]]; then
  [[ ! -L "$AGENT" ]] || { echo 'Refusing symlink LaunchAgent.' >&2; exit 1; }
  ID=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$AGENT" 2>/dev/null || true)
  EXE=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$AGENT" 2>/dev/null || true)
  [[ "$ID" == "$LABEL" && "$EXE" == "$APP/Contents/MacOS/DragonCompanion" ]] || { echo 'LaunchAgent ownership mismatch; stopped.' >&2; exit 1; }
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL" || { echo 'Watcher stop failed; preserving app and agent.' >&2; exit 1; }
  fi
  /bin/rm "$AGENT"
fi
if [[ -e "$APP" ]]; then
  mkdir -p "$HOME/.Trash"
  mv "$APP" "$HOME/.Trash/$(basename "$APP" .app).$(date +%Y%m%d-%H%M%S)-$$.app"
fi
echo 'Our installed integration removed. User settings, local media, other themes and official Codex were preserved.'
