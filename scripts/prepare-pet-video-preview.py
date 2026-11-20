#!/usr/bin/env python3
"""从固定本机归档提取预览原片；不下载、转码或修改源素材。"""
import hashlib
import json
import os
import shutil
import stat
import sys
import unicodedata
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = 'bailong-desktop-pet-v0.5.1-windows-x64-webm.zip'
ARCHIVE_PATH = Path('.local/pets/longmei/videos') / ARCHIVE
PREFIX = 'BailongPet/outputs/白龙桌宠素材/透明WebM/'
EXPECTED_BYTES = 236968505
EXPECTED_SHA256 = '4b636bf1e92a82a798b01be09cbd658cbfc46c548dd1a38acee31368b9c78580'
CATALOG = json.loads((ROOT / 'apps/desktop/src/video-preview/clip-catalog.json').read_text())
FILES = {f'{clip}.webm': f'{row["source"]}.webm' for clip, row in CATALOG.items()}
MAX_TOTAL_BYTES = 256 * 1024 * 1024

# Same approved local-only test asset as pet-build-inputs.py. Never stage this in dist.
CAPTION_FONT_BYTES = 4083908
CAPTION_FONT_SHA256 = '5f5099a065b5eb3ba55e9bd293af7707fdbd7858bf99d9381b7c6319445c2e62'


def read_local_file(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
            raise ValueError('无效的本机测试字体输入')
        return stream.read(maximum + 1)


def stage_caption_font(source, out):
    try:
        notice = read_local_file(source / 'FONT-LOCAL-TEST-NOTICE.txt', 4096)
        if b'must not be committed, published, or redistributed' not in b' '.join(notice.split()):
            return False
        data = read_local_file(source / '上首软糖体.ttf', CAPTION_FONT_BYTES)
        if len(data) != CAPTION_FONT_BYTES or hashlib.sha256(data).hexdigest() != CAPTION_FONT_SHA256:
            return False
        fd = os.open(out / 'caption-font.ttf', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        return True
    except (OSError, ValueError):
        return False


def validate_catalog(bundle):
    path = PREFIX.removesuffix('透明WebM/') + '素材清单.json'
    if bundle.namelist().count(path) != 1 or bundle.getinfo(path).file_size > 64 * 1024:
        raise ValueError('缺少或重复的固定动作清单')
    manifest = json.loads(bundle.read(path))
    rows = {}
    for key in ('idle', 'additionalIdleAnimations', 'variants', 'dragAnimation', 'landingAnimation',
                'quotaAnimation', 'workAnimations', 'movementAnimations'):
        field = manifest.get(key)
        for item in field if isinstance(field, list) else [field]:
            if item is None:
                continue
            if item['id'] in rows:
                raise ValueError('固定动作清单中有重复 ID')
            rows[item['id']] = item
    if set(rows) != {value['source'] for value in CATALOG.values()}:
        raise ValueError('固定动作清单与播放器动作集合不符')
    for value in CATALOG.values():
        source = value['source']
        row = rows[source]
        if (row.get('file') != f'透明WebM/{source}.webm' or row.get('renderAnchor') != 'bottom-center'
                or row.get('renderScale') != value['scale'] or row.get('renderOffset') != value['offset']
                or row.get('loop', source == 'drag') != value['loop']):
            raise ValueError('固定动作画面元数据与播放器目录不符')
    return rows


def write_captions(out, rows):
    lines = {}
    for target, source in CATALOG.items():
        identifier = source['source']
        if not (identifier.isascii() and identifier.isdigit() or identifier.startswith('work')):
            continue
        line = rows[identifier].get('line', '')
        if not isinstance(line, str) or line.strip() != line or len(line) > 120 or any(
                unicodedata.category(ch) in ('Cc', 'Cs') for ch in line) or len(line.encode()) > 512:
            raise ValueError('固定动作台词超出格式边界')
        if line:
            lines[target] = line
    with (out / 'captions.json').open('x', encoding='utf-8') as file:
        json.dump(lines, file, ensure_ascii=False)


def prepare(archive, out, expected_bytes, expected_sha256, *, verify_catalog=False):
    if archive.is_symlink():
        raise ValueError('v0.5.1 归档大小或类型不符')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
    fd = os.open(archive, flags)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected_bytes:
            raise ValueError('v0.5.1 归档大小或类型不符')
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        if digest.hexdigest() != expected_sha256:
            raise ValueError('v0.5.1 归档 SHA-256 不符')
        stream.seek(0)
        with zipfile.ZipFile(stream) as bundle:
            rows = validate_catalog(bundle) if verify_catalog else None
            total = 0
            for source in FILES.values():
                name = PREFIX + source
                if bundle.namelist().count(name) != 1:
                    raise ValueError('缺少或重复的固定视频素材')
                info = bundle.getinfo(name)
                if not 4 < info.file_size <= 32 * 1024 * 1024:
                    raise ValueError('预览素材超过单片大小边界')
                total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise ValueError('预览素材超过会话大小边界')
            for target, source in FILES.items():
                with bundle.open(PREFIX + source) as payload:
                    if payload.read(4) != b'\x1a\x45\xdf\xa3':
                        raise ValueError('预览素材缺少 WebM 头')
                    with (out / target).open('xb') as dest:
                        dest.write(b'\x1a\x45\xdf\xa3')
                        shutil.copyfileobj(payload, dest, length=1024 * 1024)
            if rows is not None:
                write_captions(out, rows)


def prepare_local_videos(root, out):
    archive = root / ARCHIVE_PATH
    try:
        archive.lstat()
    except FileNotFoundError:
        raise FileNotFoundError(f'缺少本机归档 {ARCHIVE_PATH.as_posix()}；不自动下载。') from None
    prepare(archive, out, EXPECTED_BYTES, EXPECTED_SHA256, verify_catalog=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('此入口仅供预览准备脚本指定独立临时目录')
    out = Path(sys.argv[1])
    # Companion-only workspaces still use the common local UI font.
    if stage_caption_font(ROOT / '.local/pet-build/local-fonts', out):
        print('已核验本机测试软糖体；仅供此临时视频会话使用。')
    else:
        print('本机测试软糖体缺失或未通过核验；桌宠气泡使用系统圆体。')

    try:
        prepare_local_videos(ROOT, out)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        sys.exit(f'本机视频预览素材准备失败：{error}')
