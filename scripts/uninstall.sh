#!/usr/bin/env bash
set -euo pipefail
LABEL='local.dragon.codex-companion.watch'
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/Dragon Codex Companion.app"
if [[ "${1:-}" != --confirm ]]; then
  echo 'Dry run only. --confirm stops our watcher and moves our installed App to Trash; settings and official Codex remain unchanged.'
  exit 0
fi
[[ $# == 1 ]] || { echo 'Unknown uninstall arguments.' >&2; exit 2; }
if [[ -e "$APP" ]]; then
  ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)
  [[ "$ID" == local.dragon.codex-companion ]] || { echo 'Refusing to touch unrelated App.' >&2; exit 1; }
fi
if [[ -f "$AGENT" ]]; then
  ID=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$AGENT" 2>/dev/null || true)
  EXE=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$AGENT" 2>/dev/null || true)
  [[ "$ID" == "$LABEL" && "$EXE" == "$APP/Contents/MacOS/DragonCompanion" ]] || { echo 'LaunchAgent ownership mismatch; stopped.' >&2; exit 1; }
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  /bin/rm "$AGENT"
fi
if [[ -e "$APP" ]]; then
  mkdir -p "$HOME/.Trash"
  mv "$APP" "$HOME/.Trash/Dragon Codex Companion.$(date +%Y%m%d-%H%M%S)-$$.app"
fi
echo 'Our installed integration removed. User settings, local media, other themes and official Codex were preserved.'
