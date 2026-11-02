"""离线宠物素材库。纯数据包；不启动 helper、不访问账号、不写既有偏好。"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import unicodedata
import warnings
import zipfile

SCHEMA = 1
MAX_ARCHIVE = 2 * 1024**3
MAX_FILE = 128 * 1024**2
MAX_TOTAL = 2 * 1024**3
MAX_METADATA = 1024**2
MAX_ENTRIES = 512
MAX_ACTIONS = 128
MAX_PIXELS = 4096**2
MAX_FRAMES = 1000
MAX_CLIP_PIXELS = 256 * 1024**2
MAX_PACKAGE_PIXELS = 4 * 1024**3
ID = re.compile(r'[a-z0-9]+(?:[.-][a-z0-9]+)*\Z')
ACTION_ID = re.compile(r'[a-zA-Z0-9_-]{1,64}\Z')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?\Z')
SHA = re.compile(r'[0-9a-f]{64}\Z')
GROUPS = ('idle', 'interaction', 'work', 'special', 'movement')


class PackageError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PackageError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024**2), b''):
            result.update(chunk)
    return result.hexdigest()


def path_name(value):
    require(isinstance(value, str) and 0 < len(value) <= 240, '无效包内路径')
    require(not any(ord(c) < 32 or ord(c) == 127 for c in value), '路径含控制字符')
    parts = value.split('/')
    require(not any(p in ('', '.', '..') for p in parts), '路径含空段或目录穿越')
    require('\\' not in value and ':' not in value and not value.startswith('/'), '仅允许相对 POSIX 路径')
    require(unicodedata.normalize('NFC', value) == value, '路径必须使用 NFC Unicode')
    return value


def read_json(path):
    def unique(pairs):
        data = {}
        for key, value in pairs:
            require(key not in data, 'JSON 含重复键')
            data[key] = value
        return data
    require(path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1, 'JSON 必须为普通文件，禁止链接')
    require(path.stat().st_size <= MAX_METADATA, 'JSON 超过大小限制')
    try:
        return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(PackageError('非法 JSON 数值')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise PackageError('JSON 格式无效') from error


def text(value, label, limit=256):
    require(isinstance(value, str) and 0 < len(value) <= limit and
            not any(ord(c) < 32 or ord(c) == 127 for c in value), label + '无效')


def integer(value, minimum, maximum, label):
    require(type(value) is int and minimum <= value <= maximum, label + '超出限制')


def validate_manifest(manifest):
    require(isinstance(manifest, dict), 'manifest 必须为对象')
    require(type(manifest.get('schemaVersion')) is int and manifest['schemaVersion'] == SCHEMA,
            '不支持的 schemaVersion')
    identifier, version = manifest.get('id'), manifest.get('version')
    require(isinstance(identifier, str) and len(identifier) <= 100 and ID.fullmatch(identifier), '包 id 无效')
    require(isinstance(version, str) and len(version) <= 64 and VERSION.fullmatch(version), '包 version 无效')
    text(manifest.get('name'), '包名称', 80)
    require(manifest.get('runtime') == 'webp-v1', '不支持的 runtime；禁止可执行包')
    sources = manifest.get('sources')
    require(isinstance(sources, list) and 1 <= len(sources) <= 8, '缺少素材来源')
    for source in sources:
        require(isinstance(source, dict), '来源必须为对象')
        for key in ('repository', 'release'):
            text(source.get(key), '来源 ' + key)
        require(isinstance(source.get('archiveSha256'), str) and SHA.fullmatch(source['archiveSha256']),
                '来源缺少归档 SHA-256')
    rights = manifest.get('rights')
    require(isinstance(rights, dict) and rights.get('scope') == 'private-local-only',
            '当前仅支持私有本地素材，不推定再分发授权')
    text(rights.get('statement'), '权利说明', 1024)
    notices = rights.get('notices')
    require(isinstance(notices, list) and 1 <= len(notices) <= 32, '必须保留来源声明')
    expected = {'manifest.json'}
    for name in notices:
        name = path_name(name)
        require(name.startswith('notices/') and name.endswith('.txt') and name not in expected, '声明路径无效或重复')
        expected.add(name)
    actions = manifest.get('actions')
    require(isinstance(actions, list) and 1 <= len(actions) <= MAX_ACTIONS, '动作数量超限')
    ids, pixels = set(), 0
    for action in actions:
        require(isinstance(action, dict), '动作必须为对象')
        aid = action.get('id')
        require(isinstance(aid, str) and ACTION_ID.fullmatch(aid) and aid not in ids, '动作 id 无效或重复')
        ids.add(aid)
        if 'name' in action:
            text(action['name'], '动作名称', 80)
        require(action.get('group') in GROUPS, '未知动作分组')
        name = path_name(action.get('file'))
        require(name.startswith('assets/') and name.endswith('.webp') and name not in expected, '素材路径无效或重复')
        expected.add(name)
        require(isinstance(action.get('sha256'), str) and SHA.fullmatch(action['sha256']), '素材 SHA-256 无效')
        integer(action.get('sizeBytes'), 1, MAX_FILE, '素材字节数')
        integer(action.get('width'), 1, 4096, '画布宽度')
        integer(action.get('height'), 1, 4096, '画布高度')
        integer(action.get('frameCount'), 1, MAX_FRAMES, '帧数')
        integer(action.get('durationMs'), 1, 120000, '动作时长')
        clip_pixels = action['width'] * action['height'] * action['frameCount']
        require(clip_pixels <= MAX_CLIP_PIXELS, '单动作解码工作量超限')
        pixels += clip_pixels
        render = action.get('presentation', {})
        require(isinstance(render, dict) and not (set(render) - {'scale', 'offset', 'anchor', 'loop'}), '未知呈现字段')
        scale = render.get('scale', 1.0)
        require(type(scale) in (int, float) and math.isfinite(scale) and .1 <= scale <= 4, '缩放无效')
        offset = render.get('offset', [0, 0])
        require(isinstance(offset, list) and len(offset) == 2 and all(
            type(v) in (int, float) and math.isfinite(v) and -2 <= v <= 2 for v in offset), '偏移无效')
        require(render.get('anchor', 'bottom-center') == 'bottom-center', '未知锚点')
        require(type(render.get('loop', False)) is bool, 'loop 必须为布尔值')
        if action['group'] == 'movement':
            move = action.get('movement')
            require(isinstance(move, dict) and set(move) == {'startMs', 'stopMs', 'facing'},
                    '移动动作必须提供完整移动参数')
            integer(move.get('startMs'), 0, action['durationMs'], '移动起点')
            integer(move.get('stopMs'), 1, action['durationMs'], '移动终点')
            require(move['startMs'] < move['stopMs'] and move.get('facing') in ('left', 'right'), '移动时段或朝向无效')
        else:
            require('movement' not in action, '仅 movement 分组允许移动参数')
    require(pixels <= MAX_PACKAGE_PIXELS, '整包解码工作量超限')
    default = manifest.get('defaultAction')
    require(isinstance(default, str) and any(a['id'] == default and a['group'] == 'idle' for a in actions),
            '默认动作必须指向待机动作')
    require(sum(a['sizeBytes'] for a in actions) <= MAX_TOTAL, '整包素材字节数超限')
    require(len({name.casefold() for name in expected}) == len(expected), '大小写冲突路径')
    return expected


def probe_webp(path):
    """顺序完整解码；仅保留当前帧，不建立整动画像素缓存。"""
    try:
        from PIL import Image
    except ImportError as error:
        raise PackageError('需要 Pillow；请使用项目 .local/pet-build/venv/bin/python') from error
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(path) as image:
                require(image.format == 'WEBP', '素材不是 WebP')
                width, height = image.size
                integer(width, 1, 4096, '实际画布宽度')
                integer(height, 1, 4096, '实际画布高度')
                frames = image.n_frames
                integer(frames, 1, MAX_FRAMES, '实际帧数')
                require(width * height * frames <= MAX_CLIP_PIXELS, '实际解码工作量超限')
                duration = 0
                for index in range(frames):
                    image.seek(index)
                    image.load()
                    milliseconds = image.info.get('duration', 0)
                    integer(milliseconds, 1, 120000, '帧时长')
                    duration += milliseconds
                    require(duration <= 120000, '实际动作时长超限')
                return dict(width=width, height=height, frameCount=frames, durationMs=duration)
    except PackageError:
        raise
    except Exception as error:
        raise PackageError('WebP 解码失败：' + Path(path).name) from error


def validate_directory(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), '素材包目录无效')
    manifest = read_json(root / 'manifest.json')
    expected = validate_manifest(manifest)
    found = set()
    total = 0
    for path in root.rglob('*'):
        require(not path.is_symlink(), '禁止符号链接')
        if path.is_dir():
            continue
        require(path.is_file() and path.stat().st_nlink == 1, '禁止非普通文件或硬链接')
        name = path_name(path.relative_to(root).as_posix())
        require(name in expected, '存在未声明的文件：' + name)
        size = path.stat().st_size
        require(size <= (MAX_FILE if name.startswith('assets/') else MAX_METADATA), '包内文件超限')
        total += size
        require(total <= MAX_TOTAL, '整包超过字节预算')
        found.add(name)
    require(found == expected, '素材包缺少声明的文件')
    for name in manifest['rights']['notices']:
        try:
            require(bool((root / name).read_text(encoding='utf-8').strip()), '来源声明为空')
        except UnicodeError as error:
            raise PackageError('来源声明必须为 UTF-8') from error
    pixels = 0
    for action in manifest['actions']:
        path = root / action['file']
        require(path.stat().st_size == action['sizeBytes'] and digest(path) == action['sha256'], '素材哈希或大小不匹配：' + action['id'])
        metadata = probe_webp(path)
        require(all(action[key] == value for key, value in metadata.items()), '素材元数据不匹配：' + action['id'])
        pixels += metadata['width'] * metadata['height'] * metadata['frameCount']
        require(pixels <= MAX_PACKAGE_PIXELS, '实际整包解码工作量超限')
    return manifest


def resolve_package(library, package_id, version):
    """解析精确包版本；验证期间持库锁，避免与协作中的删除/导入竞态。"""
    require(isinstance(package_id, str) and ID.fullmatch(package_id), '包 id 无效')
    require(isinstance(version, str) and VERSION.fullmatch(version), '包 version 无效')
    root = Path(library).expanduser()
    require(root.is_dir() and not root.is_symlink(), '素材库目录不存在或无效')
    try:
        with library_lock(root):
            packages = root / 'packages'
            family = packages / package_id
            target = family / version
            require(not packages.is_symlink() and not family.is_symlink() and not target.is_symlink(),
                    '素材包路径不能是符号链接')
            require(target.is_dir(), '指定素材包版本不存在')
            resolved_packages = packages.resolve(strict=True)
            resolved_target = target.resolve(strict=True)
            require(resolved_target.parent == resolved_packages / package_id and
                    resolved_target.is_relative_to(resolved_packages), '素材包路径越界')
            manifest = validate_directory(resolved_target)
            require(manifest['id'] == package_id and manifest['version'] == version,
                    '素材包路径与清单身份不符')
            return dict(id=package_id, version=version, path=resolved_target, manifest=manifest)
    except OSError as error:
        raise PackageError('素材包无法读取：' + str(error)) from error


def extract_archive(archive, destination):
    """先审查完整中央目录，再按限制流式复制；绝不使用 extractall。"""
    require(Path(archive).stat().st_size <= MAX_ARCHIVE, '归档超过大小限制')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        require(1 <= len(entries) <= MAX_ENTRIES, '归档条目数量超限')
        names, total = set(), 0
        for entry in entries:
            name = path_name(entry.filename)
            folded = name.casefold()
            require(folded not in names, '归档路径重复或大小写冲突')
            names.add(folded)
            require(not entry.is_dir(), '包仅允许普通文件条目，不允许目录条目')
            kind = stat.S_IFMT(entry.external_attr >> 16)
            require(kind in (0, stat.S_IFREG) and not ((entry.external_attr >> 16) & 0o111), '禁止链接、设备或可执行文件')
            require(not entry.flag_bits & 1 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), '加密或压缩算法不支持')
            allowed = name == 'manifest.json' or (name.startswith('assets/') and name.endswith('.webp')) or (name.startswith('notices/') and name.endswith('.txt'))
            require(allowed, '不支持的包内文件类型')
            limit = MAX_FILE if name.startswith('assets/') else MAX_METADATA
            require(0 <= entry.file_size <= limit, '归档单文件超限')
            require(entry.file_size <= max(1, entry.compress_size) * 200, '异常压缩比')
            total += entry.file_size
            require(total <= MAX_TOTAL, '归档解压后超出预算')
        require('manifest.json' in names, '归档缺少 manifest.json')
        copied = 0
        for entry in entries:
            target = destination / entry.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            count = 0
            with bundle.open(entry) as source, target.open('xb') as output:
                while chunk := source.read(1024**2):
                    count += len(chunk)
                    copied += len(chunk)
                    require(count <= entry.file_size and copied <= MAX_TOTAL, '流式解压超出预算')
                    output.write(chunk)
            require(count == entry.file_size, '归档文件截断')
            target.chmod(0o600)


@contextmanager
def library_lock(root):
    root = Path(root).expanduser()
    require(not root.is_symlink(), '素材库根目录不能是链接')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = root / '.library.lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_nlink == 1, '库锁文件无效')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PackageError('素材库正在操作，请稍后重试') from error
        yield root
    finally:
        os.close(fd)


def import_package(archive, library):
    require(Path(archive).suffix.lower() == '.petpack', '仅导入 .petpack 文件')
    with library_lock(library) as root:
        packages = root / 'packages'
        require(not packages.is_symlink(), 'packages 目录不能是链接')
        packages.mkdir(exist_ok=True)
        # 暂存位于同一文件系统；任何校验/磁盘错误均清理，不替换已有版本。
        with tempfile.TemporaryDirectory(prefix='.import-', dir=root) as temporary:
            stage = Path(temporary) / 'package'
            stage.mkdir()
            extract_archive(archive, stage)
            manifest = validate_directory(stage)
            family = packages / manifest['id']
            require(not family.is_symlink(), '包目录不能是链接')
            target = family / manifest['version']
            require(not target.exists() and not target.is_symlink(), '相同版本已存在；不会覆盖')
            created = not family.exists()
            family.mkdir(exist_ok=True)
            try:
                os.rename(stage, target)
            except BaseException:
                if created:
                    family.rmdir()
                raise
            return dict(id=manifest['id'], version=manifest['version'], path=str(target.resolve()),
                        actionCount=len(manifest['actions']), activated=False)


def list_packages(library):
    """只读取清单，不解码、不激活；标明尚未重新验证磁盘素材。"""
    root = Path(library).expanduser()
    if not root.exists():
        return []
    require(not root.is_symlink() and not (root / 'packages').is_symlink(), '素材库目录不能是链接')
    result = []
    for path in sorted((root / 'packages').glob('*/*')):
        require(not path.is_symlink() and not path.parent.is_symlink(), '包目录不能是链接')
        manifest = read_json(path / 'manifest.json')
        validate_manifest(manifest)
        require(path.parent.name == manifest['id'] and path.name == manifest['version'], '库路径与清单身份不符')
        result.append(dict(id=manifest['id'], version=manifest['version'], name=manifest['name'],
                           actionCount=len(manifest['actions']), assetsRevalidated=False, activated=False))
    return result


def _read_package_references(path):
    path = Path(path).expanduser()
    require(not path.is_symlink() and path.is_file(), '实例清单缺失或不是普通文件；拒绝删除')
    require(path.stat().st_nlink == 1 and path.stat().st_size <= 128 * 1024, '实例清单无效或过大；拒绝删除')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, '实例清单含重复键；拒绝删除')
            result[key] = value
        return result
    try:
        data = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(PackageError('实例清单含非法数值')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise PackageError('实例清单损坏；拒绝删除') from error
    require(isinstance(data, dict) and type(data.get('schemaVersion')) is int and
            data['schemaVersion'] == 1 and isinstance(data.get('instances'), list) and
            len(data['instances']) <= 32, '实例清单结构无效；拒绝删除')
    references = []
    for row in data['instances']:
        require(isinstance(row, dict) and not set(row) - {'id', 'package', 'enabled', 'preferences'},
                '实例定义无效；拒绝删除')
        identifier = row.get('id')
        require(isinstance(identifier, str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', identifier),
                '实例 ID 无效；拒绝删除')
        package = row.get('package') if isinstance(row, dict) else None
        require(isinstance(package, dict) and set(package) == {'id', 'version'} and
                isinstance(package.get('id'), str) and ID.fullmatch(package['id']) and
                isinstance(package.get('version'), str) and VERSION.fullmatch(package['version']),
                '实例包引用无效；拒绝删除')
        references.append((package['id'], package['version']))
    return references


def delete_package(library, package_id, version, instances_path):
    require(isinstance(package_id, str) and ID.fullmatch(package_id), '包 id 无效')
    require(isinstance(version, str) and VERSION.fullmatch(version), '包 version 无效')
    require(instances_path is not None, '未提供实例清单路径；拒绝无保护删除')
    from pet_reference_lock import ReferenceLockError, reference_lock
    try:
        with library_lock(library) as root:
            with reference_lock(instances_path):
                references = _read_package_references(instances_path)
                require((package_id, version) not in references,
                        '此素材包仍被实例清单引用（包括已停止实例），不能删除')
                packages = root / 'packages'
                family = packages / package_id
                target = family / version
                require(not packages.is_symlink() and not family.is_symlink() and
                        not target.is_symlink(), '素材包路径不能是符号链接')
                require(target.is_dir(), '素材包版本不存在')
                manifest = validate_directory(target)
                require(manifest['id'] == package_id and manifest['version'] == version,
                        '素材包路径与清单身份不符')
                tombstone = root / ('.delete-' + package_id + '-' + version + '-' + os.urandom(8).hex())
                os.rename(target, tombstone)
                try:
                    import shutil
                    shutil.rmtree(tombstone)
                except OSError as error:
                    raise PackageError('素材包已从库中移除，但隐藏临时目录清理失败：' + str(error)) from error
                try:
                    family.rmdir()
                except OSError:
                    pass
                return dict(id=package_id, version=version, deleted=True)
    except ReferenceLockError as error:
        raise PackageError(str(error)) from error


def audit_bailong(source):
    """只读现成生成目录，产出归一化目录清单；不复制 1.3GB 媒体。"""
    source = Path(source).resolve(strict=True)
    catalog = read_json(source / 'outputs/白龙桌宠素材/素材清单.json')
    patch = read_json(source / 'DRAGON_PATCH.json')
    require(patch.get('patchVersion') == 'dragon.8' and patch.get('upstreamVersion') == '0.4.1-mac.3', '当前仅适配已固定的 dragon.8 / mac.3')
    groups = [('idle', [catalog['idle']] + catalog.get('additionalIdleAnimations', [])),
              ('interaction', catalog.get('variants', [])), ('work', catalog.get('workAnimations', [])),
              ('special', [catalog.get(key) for key in ('dragAnimation', 'landingAnimation', 'quotaAnimation')]),
              ('movement', catalog.get('movementAnimations', []))]
    assets = source / 'outputs/白龙桌宠素材'
    actions, locations, seen = [], {}, set()
    for group, items in groups:
        for item in items:
            if item is None:  # 上游 work 列表可能有空占位，不是缺失的第36动作。
                continue
            aid = item['id']
            require(aid not in seen, '上游动作 id 重复')
            seen.add(aid)
            relative = path_name(item.get('playbackFile') or item['file'])
            path = assets / relative
            require(path.resolve().is_relative_to(assets.resolve()) and not path.is_symlink(), '上游素材路径越界')
            require(path.is_file() and path.stat().st_size <= MAX_FILE, '上游素材不存在或过大')
            metadata = probe_webp(path)
            require(metadata['durationMs'] == item['durationMs'], '上游动作时长不匹配：' + aid)
            action = dict(id=aid, name=item.get('name', aid), group=group, file='assets/' + aid + '.webp', sha256=digest(path),
                          sizeBytes=path.stat().st_size, **metadata,
                          presentation=dict(scale=item.get('renderScale', 1.0), offset=item.get('renderOffset', [0, 0]),
                                            anchor=item.get('renderAnchor', 'bottom-center'), loop=item.get('loop', False)))
            if group == 'movement':
                action['movement'] = dict(startMs=item['moveStartMs'], stopMs=item['moveStopMs'], facing=item['sourceFacing'])
            actions.append(action)
            locations[action['file']] = str(path.relative_to(source))
    require(len(actions) == 35, '预期固定增强版 35 动作')
    require(patch.get('upstreamArchiveSHA256') == 'c7df79f2b7e3fb90736e3ed8fb21be2fd6f8fe2d3982c494f0ee1c68004ccdb2', '基础来源归档不匹配')
    extra = patch['extraAnimations']['source']
    require(extra.get('archiveSha256') == '4b636bf1e92a82a798b01be09cbd658cbfc46c548dd1a38acee31368b9c78580', '扩展来源归档不匹配')
    for action in actions:
        expected = patch['extraAnimations']['assets'].get(action['id'])
        if action['group'] == 'movement' or action['id'] in ('idle03', 'idle04', 'idle05', 'idle06'):
            require(expected == action['sha256'], '扩展素材与补丁记录哈希不匹配')
    notices = ['ASSETS.md', 'THIRD_PARTY_NOTICES.md', 'NOTICE.md',
               'outputs/dragon-extra-notices/BailongPet/ASSETS.md',
               'outputs/dragon-extra-notices/BailongPet/README.md',
               'outputs/dragon-extra-notices/BailongPet/先看我-安装说明.txt']
    notice_records = []
    for name in notices:
        path = source / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_METADATA, '缺少上游声明或声明超限')
        require(bool(path.read_text(encoding='utf-8').strip()), '上游声明为空')
        notice_records.append(dict(source=name, file='notices/' + name + '.txt', sha256=digest(path)))
    manifest = dict(schemaVersion=SCHEMA, id='local.bailong.white-dragon', version='0.6.2-dragon.8',
                    name='白龙', runtime='webp-v1', defaultAction='idle',
                    sources=[dict(repository='chihayaanon210-spec/bailong-desktop-pet-macos', release='v0.4.1-mac.3',
                                  archiveSha256=patch['upstreamArchiveSHA256']),
                             {key: extra[key] for key in ('repository', 'release', 'archiveSha256')}],
                    rights=dict(scope='private-local-only', statement='仅私有本地开发参考；上游声明不构成本项目再分发授权。',
                                notices=[n['file'] for n in notice_records]), actions=actions)
    validate_manifest(manifest)
    return dict(manifest=manifest, sourceFiles=locations, notices=notice_records,
                summary=dict(actionCount=len(actions), groups={g: sum(a['group'] == g for a in actions) for g in GROUPS},
                             totalBytes=sum(a['sizeBytes'] for a in actions), fullFrameDecode=True,
                             installed=False, activated=False),
                scope='只读本地盘点；不是可直接安装的 petpack，也不是独立上游授权或真实桌面验收')


def write_report(path, report):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.exists() and not path.is_symlink(), '报告已存在，不覆盖')
    # 独占创建，避免覆盖任何用户文件。
    with path.open('x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2, allow_nan=False)
        output.write('\n')
