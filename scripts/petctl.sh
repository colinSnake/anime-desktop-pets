#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/build/桌边小崽.app/Contents/MacOS/DragonCompanion"
[[ -x "$BIN" ]] || { echo 'Run ./scripts/build.sh first.' >&2; exit 1; }
if [[ $# -gt 1 ]]; then echo 'Use exactly one command; see --help.' >&2; exit 2; fi
export DRAGON_DEV_ROOT="${DRAGON_DEV_ROOT:-$ROOT}"
exec "$BIN" "${1:---status}"
