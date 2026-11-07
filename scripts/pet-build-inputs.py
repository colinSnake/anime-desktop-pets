#!/usr/bin/env python3
"""Reject enhanced bundles frozen from stale local source; never launches an App."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LOCAL_TEST_FONT_SHA256 = '5f5099a065b5eb3ba55e9bd293af7707fdbd7858bf99d9381b7c6319445c2e62'
LOCAL_TEST_FONT = Path('Contents/Resources/fonts/上首软糖体.ttf')


def fingerprints(root=ROOT):
    paths = [root / 'scripts/build-pet-runtime.py', root / 'scripts/pet-build-inputs.py',
             root / 'scripts/extra-animation-overlay.py', root / 'scripts/prepare-release-animations.py']
    paths += sorted(p for p in (root / 'integrations/bailong').iterdir() if p.is_file())
    paths += [root / 'apps/pet-runtime/bailong' / name for name in
              ('dragon_frames.py', 'dragon_ui.py', 'dragon_behavior.py', 'dragon_playback.py', 'dragon_tasks.py', 'dragon_quota.py', 'dragon_visibility.py')]
    paths += [root / 'apps/pet-runtime/pets' / name for name in
              ('dragon_instances.py', 'dragon_instance_ipc.py', 'dragon_pet_helper.py', 'pet_reference_lock.py', 'pet_library.py', 'pet_sources.py')]
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def check(app, root=ROOT, require_local_test_font=False):
    metadata = json.loads((app / 'Contents/Resources/DRAGON_PATCH.json').read_text())
    font_hash = metadata.get('localTestFontSHA256')
    if require_local_test_font and font_hash is None:
        raise ValueError('本机增强桌面包必须包含 SSRuanTangTi；请使用 --local-test-font 重建 helper')
    if font_hash is not None:
        font_path = app / LOCAL_TEST_FONT
        if font_hash != LOCAL_TEST_FONT_SHA256:
            raise ValueError('增强辅助程序记录了未审核的本机测试字体哈希')
        if not font_path.is_file() or hashlib.sha256(font_path.read_bytes()).hexdigest() != font_hash:
            raise ValueError('增强辅助程序缺少 SSRuanTangTi 本机测试字体或哈希不匹配')
    expected = fingerprints(root)
    recorded = metadata.get('buildInputs', {})
    stale = sorted(k for k in set(recorded) | set(expected) if recorded.get(k) != expected.get(k))
    if stale:
        raise ValueError('增强辅助程序与源码不一致，请重新运行 build-pet-runtime.py build：' + ', '.join(stale))
    if root.resolve() == ROOT.resolve():
        executable = app / 'Contents/MacOS/BailongPet'
        viewer = root / '.local/pet-build/venv/bin/pyi-archive_viewer'
        if not executable.is_file() or not viewer.is_file():
            raise ValueError('增强辅助程序缺少冻结可执行文件或 PyInstaller 归档检查器')
        listing = subprocess.run([str(viewer), '-r', '-b', str(executable)],
                                 check=True, capture_output=True, text=True).stdout
        missing = [name for name in ('pet_reference_lock', 'pet_library', 'pet_sources', 'dragon_tasks', 'dragon_quota') if name not in listing]
        if missing:
            raise ValueError('增强辅助程序未冻结素材运行模块：' + ', '.join(missing))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--require-local-test-font', action='store_true',
                        help='拒绝不含已审核 SSRuanTangTi 本机测试字体的辅助应用')
    args = parser.parse_args()
    try:
        check(args.app, require_local_test_font=args.require_local_test_font)
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, str(error) + '\n')
    print('Enhanced helper build inputs match current source (not launched).')


if __name__ == '__main__':
    main()
