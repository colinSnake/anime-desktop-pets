#!/usr/bin/env python3
"""Publish a verified host bundle; preserve compatible old names and roll back failed moves."""
import argparse
from datetime import datetime
import os
from pathlib import Path
import plistlib
import time

APP_NAME = '桌边小崽.app'
LEGACY_APP_NAME = 'Dragon Codex Companion.app'
BUNDLE_ID = 'local.dragon.codex-companion'


def require_owned(path):
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f'Refusing non-directory or symlink app: {path}')
    with (path / 'Contents/Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    if info.get('CFBundleIdentifier') != BUNDLE_ID:
        raise ValueError(f'Refusing unrelated app: {path}')


def publish(bundle, build_dir):
    bundle, build_dir = Path(bundle), Path(build_dir)
    require_owned(bundle)
    build_dir.mkdir(parents=True, exist_ok=True)
    target = build_dir / APP_NAME
    if bundle.resolve() == target.resolve():
        raise ValueError('Staging bundle must differ from the published app')
    existing = [build_dir / name for name in (APP_NAME, LEGACY_APP_NAME)
                if os.path.lexists(build_dir / name)]
    # Validate all names first: never move one app then discover the other is unrelated.
    for path in existing:
        require_owned(path)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S') + f'-{time.time_ns()}'
    moved = []
    try:
        for path in existing:
            archive = path.with_name(f'{path.stem}.previous.{stamp}.app')
            if os.path.lexists(archive):
                raise ValueError(f'Archive already exists: {archive}')
            os.rename(path, archive)
            moved.append((path, archive))
        os.rename(bundle, target)
    except BaseException:
        for original, archive in reversed(moved):
            if os.path.lexists(original):
                raise RuntimeError(f'Rollback blocked; original preserved at {archive}')
            os.rename(archive, original)
        raise
    return target, [archive for _, archive in moved]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--build-dir', type=Path, required=True)
    args = parser.parse_args()
    target, archives = publish(args.bundle, args.build_dir)
    for archive in archives:
        print(f'Archived owned app: {archive}')
    print(f'Published: {target}')


if __name__ == '__main__':
    main()
