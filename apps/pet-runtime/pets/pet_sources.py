"""主应用桌宠管理的后台目录工具；纯数据、无窗口、不启动桌宠。"""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import zipfile

from pet_library import (MAX_ARCHIVE, MAX_ENTRIES, MAX_METADATA, MAX_TOTAL,
                         PackageError, extract_archive, library_lock, read_json,
                         require, validate_directory, validate_manifest)

MAX_SCAN_ENTRIES = 4096
MAX_SCAN_DEPTH = 5
MAX_CHOICES = 128
SKIP = {'.git', '.build', '__pycache__', 'venv', 'node_modules', 'work', 'previous', 'backups'}


def parse_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'JSON含重复键')
            result[key] = value
        return result
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
            parse_constant=lambda _: (_ for _ in ()).throw(PackageError('非法JSON数值')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise PackageError('JSON格式无效') from error


def metadata(path):
    """Bounded discovery only. Complete validation happens before adding a pet."""
    path = Path(path)
    require(not path.is_symlink(), '桌宠路径不能是链接')
    if path.is_dir():
        require(not (path / 'manifest.json').is_symlink(), '桌宠清单不能是链接')
        value = read_json(path / 'manifest.json')
    else:
        require(path.suffix.lower() == '.petpack' and path.stat().st_size <= MAX_ARCHIVE, '桌宠包无效或过大')
        with zipfile.ZipFile(path) as bundle:
            entries = bundle.infolist()
            require(1 <= len(entries) <= MAX_ENTRIES, '桌宠包条目超限')
            manifests = [item for item in entries if item.filename == 'manifest.json']
            require(len(manifests) == 1 and manifests[0].file_size <= MAX_METADATA, '桌宠清单缺失、重复或过大')
            value = parse_json(bundle.read(manifests[0]))
    validate_manifest(value)
    return value


def discover(roots, builtin=None):
    require(isinstance(roots, list) and len(roots) <= 32 and all(isinstance(p, str) for p in roots), '目录列表无效')
    choices, warnings, seen_paths, seen_packages = [], [], set(), set()
    builtin = Path(builtin).expanduser().resolve() if builtin else None
    if builtin and (builtin / '素材清单.json').is_file():
        choices.append(dict(path=str(builtin), id='local.bailong.white-dragon', version='0.0.0-builtin',
                            name='龙妹', actionCount=35, builtin=True))
    visited = 0

    def walk(path, depth):
        nonlocal visited
        if visited >= MAX_SCAN_ENTRIES or len(choices) >= MAX_CHOICES:
            return
        visited += 1
        if path.is_symlink() or not path.exists():
            return
        resolved = path.resolve()
        if resolved in seen_paths or resolved == builtin:
            return
        seen_paths.add(resolved)
        if (path.is_dir() and (path / 'manifest.json').is_file()) or path.suffix.lower() == '.petpack':
            try:
                value = metadata(path)
                key = (value['id'], value['version'])
                if key not in seen_packages:
                    choices.append(dict(path=str(resolved), id=value['id'], version=value['version'],
                                        name=value['name'], actionCount=len(value['actions']), builtin=False))
                    seen_packages.add(key)
            except (OSError, ValueError, zipfile.BadZipFile) as error:
                warnings.append(f'{path.name}：{error}'[:300])
            return
        if not path.is_dir() or depth >= MAX_SCAN_DEPTH or path.suffix.lower() in ('.app', '.framework'):
            return
        try:
            # Bound enumeration before sorting; large folders cannot allocate without limit.
            import itertools
            entries = sorted(itertools.islice(path.iterdir(), MAX_SCAN_ENTRIES + 1), key=lambda p: p.name)
            if len(entries) > MAX_SCAN_ENTRIES:
                warnings.append(f'{path.name}：目录条目过多，结果可能不完整')
            for child in entries:
                if child.name not in SKIP:
                    walk(child, depth + 1)
        except OSError as error:
            warnings.append(f'{path.name}：无法读取目录（{error.strerror}）')

    for root in roots:
        walk(Path(root).expanduser(), 0)
    if visited >= MAX_SCAN_ENTRIES or len(choices) >= MAX_CHOICES:
        warnings.append('已达到本次扫描上限；可选择更具体的桌宠目录')
    return dict(ok=True, pets=choices, warnings=warnings[:32])


def import_source(source, library):
    """Import an archive or expanded package atomically; never overwrite a version."""
    source = Path(source).expanduser()
    require(not source.is_symlink(), '桌宠路径不能是链接')
    source = source.resolve(strict=True)
    with library_lock(library) as root:
        packages = root / 'packages'
        require(not packages.is_symlink(), '桌宠安装目录不能是链接')
        packages.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.import-', dir=root) as temporary:
            stage = Path(temporary) / 'package'
            stage.mkdir()
            if source.is_dir():
                # Reject undeclared files, links and invalid media before copying.
                original = validate_directory(source)
                total = 0
                expected = validate_manifest(original)
                for name in sorted(expected):
                    path = source / name
                    require(all(not parent.is_symlink() for parent in path.parents if parent != source.parent),
                            '桌宠路径包含链接')
                    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd, 'rb') as incoming:
                        info = os.fstat(incoming.fileno())
                        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, '桌宠文件无效')
                        target = stage / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open('xb') as outgoing:
                            while chunk := incoming.read(1024 * 1024):
                                total += len(chunk)
                                require(total <= MAX_TOTAL, '桌宠总大小超限')
                                outgoing.write(chunk)
                        target.chmod(0o600)
            else:
                require(source.suffix.lower() == '.petpack', '请选择 .petpack 或含 manifest.json 的桌宠目录')
                extract_archive(source, stage)
            manifest = validate_directory(stage)
            family = packages / manifest['id']
            target = family / manifest['version']
            require(not family.is_symlink() and not target.is_symlink(), '桌宠安装路径包含链接')
            if target.exists():
                existing = validate_directory(target)
                require(existing == manifest, '相同版本已存在但内容不一致；不会覆盖')
                created = False
            else:
                family.mkdir(exist_ok=True)
                try:
                    os.rename(stage, target)
                except BaseException:
                    if not any(family.iterdir()):
                        family.rmdir()
                    raise
                created = True
            return dict(id=manifest['id'], version=manifest['version'], created=created)


def prepare(paths, library, builtin=None):
    require(isinstance(paths, list) and 1 <= len(paths) <= 16 and
            all(isinstance(path, str) for path in paths), '一次请选择1–16只桌宠')
    require(len(set(paths)) == len(paths), '桌宠路径重复')
    builtin = Path(builtin).expanduser().resolve() if builtin else None
    packages, failures = [], []
    for value in paths:
        try:
            path = Path(value).expanduser()
            require(not path.is_symlink(), '桌宠路径不能是链接')
            if builtin and path.resolve() == builtin:
                from dragon_instances import asset_identity
                result = asset_identity(builtin)
            else:
                result = import_source(path, library)
            reference = dict(id=result['id'], version=result['version'])
            if reference not in packages:
                packages.append(reference)
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            failures.append(f'{Path(value).name}：{error}'[:500])
    return dict(ok=True, packages=packages, failures=failures)


def main():
    try:
        raw = sys.stdin.buffer.read(64 * 1024 + 1)
        require(len(raw) <= 64 * 1024, '目录请求过大')
        request = parse_json(raw)
        require(isinstance(request, dict), '目录请求无效')
        if request.get('operation') == 'scan':
            result = discover(request.get('paths'), request.get('builtin'))
        elif request.get('operation') == 'prepare':
            require(isinstance(request.get('library'), str), '本地安装目录未配置')
            result = prepare(request.get('paths'), request['library'], request.get('builtin'))
        else:
            raise PackageError('未知目录操作')
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(json.dumps(dict(ok=False, error=str(error)[:1000]), ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
