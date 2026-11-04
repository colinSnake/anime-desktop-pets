#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---enhanced-pet}"
if [[ "$MODE" == --help ]]; then
  echo 'Usage: ./scripts/build.sh [--enhanced-pet | --full-pet | --native-pet]'
  echo 'Default: enhanced animated pet; build first: python3 scripts/build-pet-runtime.py build'
  echo '--full-pet explicitly selects the unchanged upstream application.'
  echo '--native-pet is the explicitly selected static-reference fallback.'
  exit 0
fi
[[ $# -le 1 && ( "$MODE" == --enhanced-pet || "$MODE" == --full-pet || "$MODE" == --native-pet ) ]] || { echo 'Unknown build option; use --help.' >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS / Xcode Command Line Tools required.' >&2; exit 1; }
PET_ASSETS_DIR="${DRAGON_PET_ASSETS_DIR:-$ROOT/.local/pet-build/source/outputs/白龙桌宠素材}"
FULL_APP="$ROOT/.local/pets/bailong-0.4.1-mac.3/BailongPet.app"
if [[ "$MODE" == --enhanced-pet ]]; then
  FULL_APP="$ROOT/.local/pet-build/dist/BailongPet.app"
fi
if [[ "$MODE" != --native-pet ]]; then
  CHECK_ARGS=(check --app "$FULL_APP")
  if [[ "$MODE" == --enhanced-pet ]]; then CHECK_ARGS+=(--assets-dir "$PET_ASSETS_DIR"); fi
  python3 "$ROOT/scripts/prepare-full-pet.py" "${CHECK_ARGS[@]}" > /dev/null || {
    echo 'Selected animated pet is not ready. Enhanced: build-pet-runtime.py build; stock: prepare-full-pet.py fetch' >&2
    echo 'No static mascot will be substituted. --native-pet selects that fallback explicitly.' >&2
    exit 1
  }
fi
if [[ "$MODE" == --enhanced-pet ]]; then
  python3 "$ROOT/scripts/pet-build-inputs.py" --app "$FULL_APP"
  [[ -s "$PET_ASSETS_DIR/素材清单.json" ]] || {
    echo "Enhanced pet assets are missing: $PET_ASSETS_DIR" >&2
    echo 'Set DRAGON_PET_ASSETS_DIR to the directory containing 素材清单.json.' >&2
    exit 1
  }
fi
for file in media/startup.mp4 pet/preview.png branding/AppIcon.icns; do
  [[ -s "$ROOT/resources/$file" ]] || { echo "Missing local asset: $file. See README import instructions." >&2; exit 1; }
done
SWIFT_APP="$ROOT/apps/companion-macos"
swift build --package-path "$SWIFT_APP" --scratch-path "$ROOT/.build" -c release --product DragonCompanion
BIN="$(swift build --package-path "$SWIFT_APP" --scratch-path "$ROOT/.build" -c release --show-bin-path)"
APP="$ROOT/build/Dragon Codex Companion.app"
# Build into a fresh staging bundle; preserve the last usable app until signing succeeds.
STAGING="$(mktemp -d "$ROOT/.build/app-stage.XXXXXX")"
trap 'test ! -d "$STAGING" || /bin/rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/Dragon Codex Companion.app/Contents/"{MacOS,Resources/Licenses}
BUNDLE="$STAGING/Dragon Codex Companion.app"
cp "$BIN/DragonCompanion" "$BUNDLE/Contents/MacOS/DragonCompanion"
cp -R "$ROOT/resources/media" "$ROOT/resources/pet" "$ROOT/resources/poster" "$BUNDLE/Contents/Resources/"
cp "$ROOT/resources/branding/AppIcon.icns" "$BUNDLE/Contents/Resources/AppIcon.icns"
# Absolute source locations in assets.local.json are deliberately not bundled.
cp "$ROOT/config/companion.example.json" "$BUNDLE/Contents/Resources/"
PET_LIBRARY_PYTHON="$ROOT/.local/pet-build/venv/bin/python"
if [[ -x "$PET_LIBRARY_PYTHON" ]] && "$PET_LIBRARY_PYTHON" -c 'import PyInstaller, PySide6, PIL' >/dev/null 2>&1; then
  LIBRARY_STAGE="$STAGING/pet-library"
  mkdir -p "$LIBRARY_STAGE"
  "$PET_LIBRARY_PYTHON" -m PyInstaller --noconfirm --clean --windowed \
    --name DragonPetLibrary --specpath "$LIBRARY_STAGE" --paths "$ROOT/apps/pet-runtime/pets" \
    --distpath "$LIBRARY_STAGE/dist" --workpath "$LIBRARY_STAGE/work" \
    "$ROOT/scripts/pet-library-ui.py"
  mkdir -p "$BUNDLE/Contents/Helpers"
  ditto "$LIBRARY_STAGE/dist/DragonPetLibrary.app" "$BUNDLE/Contents/Helpers/DragonPetLibrary.app"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier local.dragon.codex-companion.pet-library' \
    "$BUNDLE/Contents/Helpers/DragonPetLibrary.app/Contents/Info.plist"
  codesign --force --deep --sign - "$BUNDLE/Contents/Helpers/DragonPetLibrary.app"
fi
if [[ "$MODE" != --native-pet ]]; then
  mkdir -p "$BUNDLE/Contents/Helpers"
  ditto "$FULL_APP" "$BUNDLE/Contents/Helpers/BailongPet.app"
  python3 - "$BUNDLE/Contents/Resources/companion.example.json" "$MODE" "$PET_ASSETS_DIR" <<'PYCONFIG'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); config=json.loads(p.read_text())
config.update(petBackend='external',externalPetAppPath='../Helpers/BailongPet.app')
if sys.argv[2] == '--enhanced-pet':
    config['externalPetAssetsPath'] = str(Path(sys.argv[3]).expanduser().resolve())
p.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
PYCONFIG
fi
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$BUNDLE/Contents/Resources/Licenses/"
cp "$ROOT/licenses/"*.md "$BUNDLE/Contents/Resources/Licenses/"
python3 - "$BUNDLE/Contents/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1],'wb') as out:
    plistlib.dump(dict(CFBundleName='Dragon Codex Companion', CFBundleDisplayName='Dragon Codex Companion',
        CFBundleExecutable='DragonCompanion', CFBundleIdentifier='local.dragon.codex-companion',
        CFBundleIconFile='AppIcon.icns',
        CFBundlePackageType='APPL', CFBundleShortVersionString='0.7.7', CFBundleVersion='27',
        LSMinimumSystemVersion='13.0', LSUIElement=True, NSHighResolutionCapable=True),out)
PY
codesign --force --sign - "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"
mkdir -p "$ROOT/build"
if [[ -e "$APP" ]]; then
  ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)
  [[ "$ID" == 'local.dragon.codex-companion' ]] || { echo 'Refusing to replace unrelated App.' >&2; exit 1; }
  # Keep the prior app intact until the new bundle has been signed and verified.
  mv "$APP" "$ROOT/build/Dragon Codex Companion.previous.$(date +%Y%m%d-%H%M%S)-$$.app"
fi
mv "$BUNDLE" "$APP"
python3 "$ROOT/scripts/clean-builds.py"
printf '\nBuilt: %s\nPet mode: %s\nNot launched. No login item installed.\n' "$APP" "$MODE"
