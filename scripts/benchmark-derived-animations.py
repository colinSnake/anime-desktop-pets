#!/usr/bin/env python3
"""只读评估动作派生：实际预乘像素、Qt合成、时序及逐帧zlib候选；不启动桌宠。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import struct
import sys
import time
import zlib

ROOT = Path(__file__).resolve().parents[1]


def webp_metadata(path):
    """有界读取RIFF头；保留原始毫秒值，不把0时长静默改成1。"""
    path = Path(path)
    frames, loop, background = [], None, None
    with path.open('rb') as source:
        header = source.read(12)
        if len(header) != 12 or header[:4] != b'RIFF' or header[8:] != b'WEBP':
            raise ValueError('不是WebP：' + str(path))
        end = int.from_bytes(header[4:8], 'little') + 8
        if end != path.stat().st_size:
            raise ValueError('RIFF长度与文件不符')
        while source.tell() < end:
            if end - source.tell() < 8:
                raise ValueError('chunk头截断')
            kind, length = struct.unpack('<4sI', source.read(8))
            stop = source.tell() + length + (length & 1)
            if stop > end:
                raise ValueError('chunk越界')
            if kind == b'ANIM':
                if length != 6 or loop is not None:
                    raise ValueError('ANIM无效或重复')
                payload = source.read(6)
                background = payload[:4].hex()
                loop = int.from_bytes(payload[4:], 'little')
            elif kind == b'ANMF':
                if length < 16 or len(frames) >= 2000:
                    raise ValueError('ANMF无效或帧数超限')
                payload = source.read(16)
                frames.append(dict(durationMs=int.from_bytes(payload[12:15], 'little'),
                                   flags=payload[15]))
            source.seek(stop)
    return dict(frameCount=len(frames), durationsMs=[x['durationMs'] for x in frames],
                flags=sorted(set(x['flags'] for x in frames)), loop=loop,
                backgroundBGRA=background)


def action_paths(assets):
    assets = Path(assets).resolve(strict=True)
    manifest = json.loads((assets / '素材清单.json').read_text(encoding='utf-8'))
    items = [manifest['idle'], *manifest.get('additionalIdleAnimations', []),
             *manifest.get('variants', []), *manifest.get('workAnimations', []),
             *[manifest.get(key) for key in ('dragAnimation', 'landingAnimation', 'quotaAnimation')],
             *manifest.get('movementAnimations', [])]
    result, seen = [], set()
    for item in filter(None, items):
        if item['id'] in seen:
            raise ValueError('重复动作ID：' + item['id'])
        seen.add(item['id'])
        relative = item.get('playbackFile') or item['file'].replace('.webm', '.webp')
        path = assets / relative
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(assets):
            raise ValueError('素材路径越界或为链接')
        result.append((item, path))
    return result


def pixel_difference(expected, actual):
    """逐通道直方图，不使用忽略RGB差异的RGBA getbbox默认行为。"""
    from PIL import Image, ImageChops
    if len(expected) != len(actual) or len(expected) % 4 or not expected:
        raise ValueError('像素字节长度不匹配')
    left = Image.frombytes('RGBA', (len(expected) // 4, 1), expected)
    right = Image.frombytes('RGBA', left.size, actual)
    histogram = ImageChops.difference(left, right).histogram()
    maximum = changed = absolute = 0
    for band in range(4):
        values = histogram[band * 256:(band + 1) * 256]
        changed += sum(values[1:])
        absolute += sum(index * count for index, count in enumerate(values))
        maximum = max(maximum, max((i for i, n in enumerate(values) if n), default=0))
    return dict(maximum=maximum, changedChannels=changed, absoluteSum=absolute,
                channels=len(expected))


def composite(image, background):
    from PySide6.QtGui import QImage, QColor, QPainter
    target = QImage(image.width(), image.height(), QImage.Format.Format_RGBA8888)
    target.fill(QColor(background))
    painter = QPainter(target)
    try:
        painter.drawImage(0, 0, image)
    finally:
        painter.end()
    return bytes(target.constBits())


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def empty_difference():
    return dict(maximum=0, changedChannels=0, absoluteSum=0, channels=0)


def accumulate(target, sample):
    target['maximum'] = max(target['maximum'], sample['maximum'])
    for key in ('changedChannels', 'absoluteSum', 'channels'):
        target[key] += sample[key]


def assess(source, size, derived=None):
    from PIL import Image
    # QImage only: no QApplication, QPixmap, UI, real profile, network or task adapter.
    from dragon_frames import decode_image
    before = digest(source)
    metadata = webp_metadata(source)
    candidate_metadata = webp_metadata(derived) if derived is not None else None
    result = dict(source=str(source), sourceSHA256=before, sourceBytes=source.stat().st_size,
                  size=size, metadata=metadata, decodedFrames=0, runtimeDecodeSeconds=0.,
                  rawBytes=0, zlibBytes=0, zlibCompressSeconds=0., zlibDecodeSeconds=0.,
                  zlibRoundTripExact=True)
    comparisons = {name: empty_difference() for name in ('premultiplied', 'qtBlack', 'qtWhite')}
    alternate = Image.open(derived) if derived is not None else None
    try:
        with Image.open(source) as image:
            result['sourceDimensions'] = list(image.size)
            if metadata['frameCount'] != image.n_frames:
                raise ValueError('RIFF帧数与实际解码帧数不一致')
            if alternate is not None:
                result.update(derived=str(derived), derivedSHA256=digest(derived),
                              derivedBytes=derived.stat().st_size,
                              derivedMetadata=candidate_metadata, derivedDecodeSeconds=0.,
                              timelineExact=metadata['durationsMs'] == candidate_metadata['durationsMs'],
                              loopExact=metadata['loop'] == candidate_metadata['loop'],
                              frameCountExact=image.n_frames == alternate.n_frames)
                if not result['frameCountExact']:
                    raise ValueError('派生帧数不同；不将部分帧比较误报为全量通过')
            for index in range(image.n_frames):
                started = time.perf_counter()
                expected = decode_image(image, index, size)
                result['runtimeDecodeSeconds'] += time.perf_counter() - started
                raw = bytes(expected.constBits())
                result['rawBytes'] += len(raw)
                started = time.perf_counter()
                packed = zlib.compress(raw, level=1)
                result['zlibCompressSeconds'] += time.perf_counter() - started
                result['zlibBytes'] += len(packed)
                started = time.perf_counter()
                unpacked = zlib.decompress(packed)
                result['zlibDecodeSeconds'] += time.perf_counter() - started
                result['zlibRoundTripExact'] &= unpacked == raw
                if alternate is not None:
                    started = time.perf_counter()
                    actual = decode_image(alternate, index, size)
                    result['derivedDecodeSeconds'] += time.perf_counter() - started
                    accumulate(comparisons['premultiplied'], pixel_difference(raw, bytes(actual.constBits())))
                    for key, background in (('qtBlack', 'black'), ('qtWhite', 'white')):
                        accumulate(comparisons[key], pixel_difference(composite(expected, background),
                                                                    composite(actual, background)))
                result['decodedFrames'] += 1
                if index and index % 100 == 0:
                    print(f'  frame {index}/{image.n_frames}', flush=True)
    finally:
        if alternate is not None:
            alternate.close()
    if digest(source) != before:
        raise ValueError('评估期间源素材发生变化')
    result['sourceUnchanged'] = True
    if alternate is not None:
        result['comparisons'] = comparisons
        result['runtimePixelsExact'] = all(not value['changedChannels'] for value in comparisons.values())
    return result


def write_report(path, report, assets, derived=None):
    path = Path(path).absolute()
    for root in filter(None, (assets, derived)):
        if path.resolve().is_relative_to(Path(root).resolve()):
            raise ValueError('报告不能写入源素材或派生素材目录')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2, allow_nan=False)
        output.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-dir', type=Path, required=True)
    parser.add_argument('--derived-dir', type=Path,
                        help='可选：读取前次全动作评估生成的NN-源文件名.webp，只比较不改写')
    parser.add_argument('--size', type=int, choices=(256, 512), default=256)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    # No widget is created, but explicitly avoid inherited native preview styles.
    os.environ.update(QT_QPA_PLATFORM='offscreen', QT_STYLE_OVERRIDE='Fusion')
    sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
    from PIL import __version__ as pillow_version
    from PySide6 import __version__ as pyside_version
    # Fail before expensive reads for an unsafe/existing report destination.
    if args.output.exists() or args.output.is_symlink():
        parser.error('报告已存在；请使用新路径，不覆盖证据')
    for root in filter(None, (args.assets_dir, args.derived_dir)):
        if args.output.resolve().is_relative_to(root.resolve()):
            parser.error('报告不能写入素材目录')
    report = dict(scope='只读完整动作审计；zlib逐帧流量实验，不是运行时缓存实现或桌面性能承诺',
                  environment=dict(platform=platform.platform(), python=platform.python_version(),
                                   pillow=pillow_version, pyside=pyside_version, zlib=zlib.ZLIB_VERSION),
                  size=args.size, actions=[], completed=False)
    started = time.monotonic()
    for number, (item, path) in enumerate(action_paths(args.assets_dir), 1):
        target = args.derived_dir / f'{number:02d}-{path.name}' if args.derived_dir else None
        print(f'[{number}] {item["id"]}: {path.name}', flush=True)
        result = assess(path, args.size, target)
        result['id'] = item['id']
        result['manifestDurationMs'] = item.get('durationMs')
        report['actions'].append(result)
    keys = ('sourceBytes', 'rawBytes', 'zlibBytes', 'runtimeDecodeSeconds',
            'zlibCompressSeconds', 'zlibDecodeSeconds', 'decodedFrames')
    report['totals'] = {key: sum(x[key] for x in report['actions']) for key in keys}
    report.update(completed=True, elapsedSeconds=time.monotonic() - started,
                  allSourcesUnchanged=all(x['sourceUnchanged'] for x in report['actions']),
                  zlibRoundTripExact=all(x['zlibRoundTripExact'] for x in report['actions']))
    if args.derived_dir:
        report['webpCandidateAccepted'] = all(x['runtimePixelsExact'] and x['timelineExact'] and
                                            x['loopExact'] and x['frameCountExact'] for x in report['actions'])
    write_report(args.output, report, args.assets_dir, args.derived_dir)
    print(json.dumps({key: value for key, value in report.items() if key != 'actions'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
