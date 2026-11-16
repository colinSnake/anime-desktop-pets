#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---enhanced-pet}"
show_enhanced_rebuild_instructions() {
  echo 'Enhanced helper is missing, outdated, or invalid. Rebuild it before packaging the host:'
  printf '  cd %q\n' "$ROOT"
  echo '  LOCAL_TEST_FONT=".local/pet-build/local-fonts/上首软糖体.ttf"'
  echo '  PET_SKIP_BUILD_CLEANUP=1 python3 scripts/build-pet-runtime.py build --source-revision 8e5466d9a438deb6cb43f460e7f5a9bdb9d7a578 --local-test-font "$LOCAL_TEST_FONT" && PET_SKIP_BUILD_CLEANUP=1 ./scripts/build.sh --enhanced-pet'
  echo 'Old-brand apps/services need manual handling; see docs/产品命名与重建.md. No app or service was changed.'
}
if [[ "$MODE" == --help ]]; then
  echo 'Usage: ./scripts/build.sh [--enhanced-pet | --full-pet | --native-pet]'
  echo 'Default: enhanced animated pet; helper must be rebuilt first with the pinned revision and local font.'
  show_enhanced_rebuild_instructions
  echo '--full-pet explicitly selects the unchanged upstream application.'
  echo '--native-pet is the explicitly selected static-reference fallback.'
  exit 0
fi
[[ $# -le 1 && ( "$MODE" == --enhanced-pet || "$MODE" == --full-pet || "$MODE" == --native-pet ) ]] || { echo 'Unknown build option; use --help.' >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS / Xcode Command Line Tools required.' >&2; exit 1; }
PET_ASSETS_DIR="${PET_ASSETS_DIR:-$ROOT/.local/pet-build/source/outputs/白龙桌宠素材}"
FULL_APP="$ROOT/.local/pets/bailong-0.4.1-mac.3/BailongPet.app"
if [[ "$MODE" == --enhanced-pet ]]; then
  FULL_APP="$ROOT/.local/pet-build/dist/BailongPet.app"
fi
if [[ "$MODE" != --native-pet ]]; then
  CHECK_ARGS=(check --app "$FULL_APP")
  if [[ "$MODE" == --enhanced-pet ]]; then CHECK_ARGS+=(--assets-dir "$PET_ASSETS_DIR"); fi
  python3 "$ROOT/scripts/prepare-full-pet.py" "${CHECK_ARGS[@]}" > /dev/null || {
    if [[ "$MODE" == --enhanced-pet ]]; then
      show_enhanced_rebuild_instructions >&2
    else
      echo 'Selected stock animated pet is not ready. Run: python3 scripts/prepare-full-pet.py fetch' >&2
    fi
    echo 'No static mascot will be substituted. --native-pet selects that fallback explicitly.' >&2
    exit 1
  }
fi
if [[ "$MODE" == --enhanced-pet ]]; then
  python3 "$ROOT/scripts/pet-build-inputs.py" --app "$FULL_APP" --require-local-test-font || {
    show_enhanced_rebuild_instructions >&2
    exit 1
  }
  [[ -s "$PET_ASSETS_DIR/素材清单.json" ]] || {
    echo "Enhanced pet assets are missing: $PET_ASSETS_DIR" >&2
    echo 'Set PET_ASSETS_DIR to the directory containing 素材清单.json.' >&2
    exit 1
  }
fi
for file in media/startup.mp4 pet/preview.png branding/AppIcon.icns; do
  [[ -s "$ROOT/resources/$file" ]] || { echo "Missing local asset: $file. See README import instructions." >&2; exit 1; }
done
SWIFT_APP="$ROOT/apps/companion-macos"
swift build --package-path "$SWIFT_APP" --scratch-path "$ROOT/.build" -c release --product PetCompanion
BIN="$(swift build --package-path "$SWIFT_APP" --scratch-path "$ROOT/.build" -c release --show-bin-path)"
APP="$ROOT/build/桌边小崽.app"
# Build into a fresh staging bundle; preserve the last usable app until signing succeeds.
STAGING="$(mktemp -d "$ROOT/.build/app-stage.XXXXXX")"
trap 'test ! -d "$STAGING" || /bin/rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/桌边小崽.app/Contents/"{MacOS,Resources/Licenses}
BUNDLE="$STAGING/桌边小崽.app"
cp "$BIN/PetCompanion" "$BUNDLE/Contents/MacOS/PetCompanion"
# SwiftUI's welcome mark is a package resource. Keep its bundle where Bundle.module
# resolves resources in the packaged app, rather than relying on the build directory.
ditto "$BIN/AnimeDesktopPets_CharacterUI.bundle" \
  "$BUNDLE/Contents/Resources/AnimeDesktopPets_CharacterUI.bundle"
cp -R "$ROOT/resources/media" "$ROOT/resources/pet" "$ROOT/resources/poster" "$BUNDLE/Contents/Resources/"
cp "$ROOT/resources/branding/AppIcon.icns" "$BUNDLE/Contents/Resources/AppIcon.icns"
# This is a local development build: Finder needs the same private speech runtime
# checkout as petctl. No model, reference audio, transcript or credential is copied.
python3 - "$BUNDLE/Contents/Resources/speech-development-root.json" "$ROOT" <<'PYSPEECH'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps(str(Path(sys.argv[2]).resolve()), ensure_ascii=False) + '\n')
PYSPEECH
# Absolute source locations in assets.local.json are deliberately not bundled.
cp "$ROOT/config/companion.example.json" "$BUNDLE/Contents/Resources/"
# Local project discovery hints; keep machine-specific paths out of Swift code.
python3 - "$BUNDLE/Contents/Resources/pet-search-directories.json" "$ROOT" <<'PYSOURCES'
import json, sys
from pathlib import Path
root = Path(sys.argv[2])
Path(sys.argv[1]).write_text(json.dumps([str(root / name) for name in
    ('resources/pets', 'pets', '.local/pets')], ensure_ascii=False) + '\n')
PYSOURCES
if [[ "$MODE" != --native-pet ]]; then
  mkdir -p "$BUNDLE/Contents/Helpers"
  ditto "$FULL_APP" "$BUNDLE/Contents/Helpers/BailongPet.app"
  if [[ "$MODE" == --enhanced-pet ]]; then
    # Validate the embedded copy, not only the source helper, before signing or publishing.
    python3 "$ROOT/scripts/pet-build-inputs.py" \
      --app "$BUNDLE/Contents/Helpers/BailongPet.app" \
      --require-local-test-font
  fi
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
    plistlib.dump(dict(CFBundleName='桌边小崽', CFBundleDisplayName='桌边小崽',
        CFBundleExecutable='PetCompanion', CFBundleIdentifier='local.anime-desktop-pets.companion',
        CFBundleIconFile='AppIcon.icns',
        CFBundlePackageType='APPL', CFBundleShortVersionString='0.7.11', CFBundleVersion='32',
        NSMicrophoneUsageDescription='用于将你的语音在本机转成文字并生成桌宠回复。录音不会上传或保存为聊天历史。',
        LSMinimumSystemVersion='13.0', NSHighResolutionCapable=True),out)
PY
codesign --force --sign - "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"
# Publish the signed bundle atomically, archiving only our old/new named apps.
# The publisher validates every destination before moving anything and rolls back on failure.
python3 "$ROOT/scripts/publish-app-bundle.py" --bundle "$BUNDLE" --build-dir "$ROOT/build"
if [[ "${PET_SKIP_BUILD_CLEANUP:-0}" == 1 ]]; then
  echo 'Skipped build archive cleanup (PET_SKIP_BUILD_CLEANUP=1).'
else
  python3 "$ROOT/scripts/clean-builds.py"
fi
printf '\nBuilt: %s\nPet mode: %s\nNot launched. No login item installed.\n' "$APP" "$MODE"
