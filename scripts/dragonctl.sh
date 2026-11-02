#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/build/Dragon Codex Companion.app/Contents/MacOS/DragonCompanion"
[[ -x "$BIN" ]] || { echo 'Run ./scripts/build.sh first.' >&2; exit 1; }
if [[ $# -gt 1 ]]; then echo 'Use exactly one command; see --help.' >&2; exit 2; fi
exec "$BIN" "${1:---status}"
