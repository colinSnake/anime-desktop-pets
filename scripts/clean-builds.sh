#!/usr/bin/env bash
# Shell entry point; keep archive selection and in-use protection in Python.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$ROOT/scripts/clean-builds.py" "$@"
