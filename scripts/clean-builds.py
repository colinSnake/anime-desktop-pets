#!/usr/bin/env python3
"""清理闲置构建归档；显式 --caches 才清理可再生编译缓存。"""
import argparse
from pathlib import Path
import re
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HOST_HISTORY = ROOT / 'build'
HELPER_HISTORY = ROOT / '.local/pet-build/previous'
HOST_PATTERN = re.compile(r'^桌边小崽\.previous\.\d{8}-\d{6}-\d+\.app$')
HELPER_PATTERN = re.compile(r'^\d{8}-\d{6}$')
SCRATCH_ROOTS = ('.build', 'apps/companion-macos/.build',
                 '.local/multi-pet-validation/swift-build')
CACHE_NAMES = ('CompilationCache.noindex', 'ModuleCache.noindex',
               'SDKExplicitPrecompiledModules', 'SDKStatCaches.noindex',
               'Intermediates.noindex', 'v5', 'PCH')



def allocated_kib(path):
    result = subprocess.run(['du', '-sk', str(path)], check=True, capture_output=True, text=True)
    return int(result.stdout.split()[0])


def owned_bundle(path, identity):
    try:
        with (path / 'Contents/Info.plist').open('rb') as stream:
            return plistlib.load(stream).get('CFBundleIdentifier') == identity
    except (OSError, ValueError, plistlib.InvalidFileException, AttributeError):
        return False


def owned_host(path):
    return owned_bundle(path, 'local.dragon.codex-companion')


def safe_directory(path):
    """不跨越仓库内任何符号链接，也不接受目录本身的链接。"""
    try:
        relative = path.relative_to(ROOT)
        current = ROOT
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                return False
        return path.is_dir()
    except (OSError, ValueError):
        return False


def self_contained_helper(path):
    if not safe_directory(path) or not owned_bundle(path, 'local.bailongpet.macos'):
        return False
    try:
        for item in path.rglob('*'):
            if item.is_symlink():
                item.resolve(strict=True).relative_to(path.resolve())
        result = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(path)],
                                capture_output=True, text=True)
        return result.returncode == 0
    except (OSError, RuntimeError, ValueError):
        return False


def cache_candidates():
    """固定白名单，不包含 Products、素材、环境、下载及任何验证报告。"""
    found = []
    for scratch in SCRATCH_ROOTS:
        for name in CACHE_NAMES:
            path = ROOT / scratch / 'out' / name
            if safe_directory(path):
                found.append(path)
    for relative in ('.local/pet-build/work', '.local/pet-build/pyinstaller-cache'):
        path = ROOT / relative
        if safe_directory(path):
            found.append(path)
    duplicate = ROOT / '.local/pet-build/dist/BailongPet'
    current = ROOT / '.local/pet-build/dist/BailongPet.app'
    if safe_directory(duplicate) and self_contained_helper(current):
        found.append(duplicate)
    return found


def active_builds():
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,command='], check=True,
                            capture_output=True, text=True)
    names = {'swift', 'swift-build', 'swift-test', 'swift-frontend', 'swiftc',
             'xcodebuild', 'clang', 'clang++', 'ld', 'PyInstaller', 'pyinstaller'}
    markers = ('scripts/build-pet-runtime.py', 'scripts/build.sh',
               'swift test ', 'swift build ', 'PyInstaller', 'pyinstaller')
    found = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and (Path(parts[1].split()[0]).name in names
                                or any(marker in parts[1] for marker in markers)):
            found.append(f'{parts[0]} {parts[1][:160]}')
    return found


def candidates(host=True, helper=True):
    found = []
    if (host and safe_directory(HOST_HISTORY)
            and safe_directory(HOST_HISTORY / '桌边小崽.app')
            and owned_host(HOST_HISTORY / '桌边小崽.app')):
        found.extend(path for path in HOST_HISTORY.iterdir()
                     if HOST_PATTERN.fullmatch(path.name) and safe_directory(path) and owned_host(path))
    if (helper and safe_directory(HELPER_HISTORY)
            and self_contained_helper(ROOT / '.local/pet-build/dist/BailongPet.app')):
        for path in HELPER_HISTORY.iterdir():
            if not HELPER_PATTERN.fullmatch(path.name) or not safe_directory(path):
                continue
            apps = list(path.iterdir())
            if len(apps) == 1 and apps[0].name == 'BailongPet.app' and safe_directory(apps[0]) and owned_bundle(apps[0], 'local.bailongpet.macos'):
                found.append(path)
    return found


def busy_paths(paths):
    if not paths:
        return set()
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-Fpn'], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError('无法检查候选路径是否正在使用；未删除任何文件')
    opened = [line[1:].removesuffix(' (deleted)') for line in result.stdout.splitlines() if line.startswith('n/')]
    return {path for path in paths if any(name == str(path) or name.startswith(str(path) + '/') for name in opened)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper-archives-only', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--dry-run', action='store_true', help='只列出将清理的路径和占用')
    parser.add_argument('--caches', action='store_true', help='额外清理白名单编译/PyInstaller缓存；下次构建会重建')
    args = parser.parse_args(argv)
    if args.caches and args.helper_archives_only:
        parser.error('--caches 不能与内部 helper 归档选项同时使用')
    try:
        if args.caches:
            builds = active_builds()
            if builds:
                raise RuntimeError('检测到构建进程，未删除任何文件：' + ', '.join(builds))
        paths = list(candidates(host=not args.helper_archives_only, helper=True))
        if args.caches:
            paths.extend(cache_candidates())
        busy = busy_paths(paths)
        entries = [(path, allocated_kib(path)) for path in paths if path not in busy]
        for path in sorted(busy):
            print(f'跳过（仍被使用）: {path}')
        for path, size in entries:
            print(f'{"预览" if args.dry_run else "清理"}: {path} ({size / 1024:.1f} MiB)')
            if not args.dry_run:
                # 复核路径/占用；不因符号链接替换或新打开文件而跨边界删除。
                if (not safe_directory(path) or busy_paths([path])
                        or (path.name == 'BailongPet' and not self_contained_helper(path.with_name('BailongPet.app')))):
                    raise RuntimeError('候选路径已变化或被占用，停止后续清理：' + str(path))
                if args.caches and active_builds():
                    raise RuntimeError('清理期间出现构建进程，停止后续清理')
                shutil.rmtree(path)
        total = sum(size for _, size in entries)
        print(f'{"预计释放" if args.dry_run else "已回收"}: {total / 1024:.1f} MiB；处理 {len(entries)} 个归档/缓存目录，跳过 {len(busy)} 个正在使用的目录。')
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
