#!/usr/bin/env python3
"""Reject enhanced bundles frozen from stale local source; never launches an App."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def fingerprints(root=ROOT):
    paths = [root / 'scripts/build-pet-runtime.py', root / 'scripts/pet-build-inputs.py',
             root / 'scripts/extra-animation-overlay.py', root / 'scripts/prepare-release-animations.py']
    paths += sorted(p for p in (root / 'integrations/bailong').iterdir() if p.is_file())
    paths += [root / 'apps/pet-runtime/bailong' / name for name in
              ('dragon_frames.py', 'dragon_ui.py', 'dragon_behavior.py', 'dragon_playback.py', 'dragon_tasks.py', 'dragon_quota.py')]
    paths += [root / 'apps/pet-runtime/pets' / name for name in
              ('dragon_instances.py', 'dragon_instance_ipc.py', 'dragon_pet_helper.py', 'pet_reference_lock.py', 'pet_library.py')]
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def check(app, root=ROOT):
    metadata = json.loads((app / 'Contents/Resources/DRAGON_PATCH.json').read_text())
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
        missing = [name for name in ('pet_reference_lock', 'pet_library', 'dragon_tasks', 'dragon_quota') if name not in listing]
        if missing:
            raise ValueError('增强辅助程序未冻结素材运行模块：' + ', '.join(missing))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    args = parser.parse_args()
    try:
        check(args.app)
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, str(error) + '\n')
    print('Enhanced helper build inputs match current source (not launched).')


if __name__ == '__main__':
    main()
