#!/usr/bin/env python3
"""Remove only owned archived host and BailongPet build bundles."""
import argparse
from pathlib import Path
import re
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HOST_HISTORY = ROOT / 'build'
HELPER_HISTORY = ROOT / '.local/pet-build/previous'
HOST_PATTERN = re.compile(r'^(?:桌边小崽|Dragon Codex Companion)\.previous\.\d{8}-\d{6}-\d+\.app$')
HELPER_PATTERN = re.compile(r'^\d{8}-\d{6}$')


def allocated_kib(path):
    result = subprocess.run(['du', '-sk', str(path)], check=True, capture_output=True, text=True)
    return int(result.stdout.split()[0])


def owned_host(path):
    try:
        with (path / 'Contents/Info.plist').open('rb') as stream:
            return plistlib.load(stream).get('CFBundleIdentifier') == 'local.dragon.codex-companion'
    except (OSError, ValueError, plistlib.InvalidFileException, AttributeError):
        return False


def candidates(host=True, helper=True):
    found = []
    if host and HOST_HISTORY.is_dir():
        found.extend(path for path in HOST_HISTORY.iterdir()
                     if HOST_PATTERN.fullmatch(path.name) and path.is_dir() and not path.is_symlink() and owned_host(path))
    if helper and HELPER_HISTORY.is_dir():
        for path in HELPER_HISTORY.iterdir():
            if not HELPER_PATTERN.fullmatch(path.name) or not path.is_dir() or path.is_symlink():
                continue
            apps = list(path.iterdir())
            if len(apps) == 1 and apps[0].name == 'BailongPet.app' and apps[0].is_dir() and not apps[0].is_symlink():
                found.append(path)
    return found


def busy_paths(paths):
    if not paths:
        return set()
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-Fpn'], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError('无法检查历史 App 是否正在使用；未删除任何文件')
    opened = [line[1:].removesuffix(' (deleted)') for line in result.stdout.splitlines() if line.startswith('n/')]
    return {path for path in paths if any(name == str(path) or name.startswith(str(path) + '/') for name in opened)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper-archives-only', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--dry-run', action='store_true', help='只列出将清理的历史构建和占用')
    args = parser.parse_args()
    paths = candidates(host=not args.helper_archives_only, helper=True)
    try:
        busy = busy_paths(paths)
        entries = [(path, allocated_kib(path)) for path in paths if path not in busy]
        for path in sorted(busy):
            print(f'跳过（仍被使用）: {path}')
        for path, size in entries:
            print(f'{"预览" if args.dry_run else "清理"}: {path} ({size / 1024:.1f} MiB)')
            if not args.dry_run:
                shutil.rmtree(path)
        total = sum(size for _, size in entries)
        print(f'{"预计释放" if args.dry_run else "已回收"}: {total / 1024:.1f} MiB；处理 {len(entries)} 个历史归档，跳过 {len(busy)} 个正在使用的归档。')
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
