#!/usr/bin/env python3
"""生成松手专用384px短循环缓存；原35动作与源文件只读，不启动桌宠。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
from dragon_frames import webp_frame_durations
from dragon_playback import release_source_key

ALGORITHM = 'release-loop-v1-384'
IDS = {'move02', 'move02left', 'move03left', 'move03right'}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare(assets, cache):
    assets, cache = assets.resolve(), cache.resolve()
    manifest = json.loads((assets / '素材清单.json').read_text())
    items = [v for v in manifest.get('movementAnimations', []) if v['id'] in IDS]
    if {v['id'] for v in items} != IDS:
        raise ValueError('白龙松手缓存需要已校验的四个左右奔跑／飞行动作')
    cache.mkdir(parents=True, exist_ok=True)
    output = assets / 'dragon-release'
    output.mkdir(exist_ok=True)
    profiles = {}
    for item in items:
        relative = Path(item.get('playbackFile') or item['file'].replace('.webm', '.webp'))
        source = (assets / relative).resolve()
        if relative.is_absolute() or '..' in relative.parts or not source.is_relative_to(assets):
            raise ValueError('源素材路径越界')
        source_sha = digest(source)
        key = hashlib.sha256((ALGORITHM + source_sha + release_source_key(item)).encode()).hexdigest()
        cached = cache / (item['id'] + '-' + key[:20] + '.webp')
        info_path = cached.with_suffix('.json')
        info = json.loads(info_path.read_text()) if info_path.is_file() else None
        if info is None or not cached.is_file() or digest(cached) != info.get('sha256'):
            durations = webp_frame_durations(source)
            total = sum(durations)
            starts, position = [], 0
            for duration in durations:
                starts.append(position * item['durationMs'] / total)
                position += duration
            from bisect import bisect_right
            first = max(0, bisect_right(starts, item['moveStartMs']) - 1)
            last = max(first + 1, bisect_right(starts, item['moveStopMs'] - 1e-6) - 1)
            thumbs = {}
            with Image.open(source) as reader:
                for index in range(first, last + 1):
                    reader.seek(index)
                    rgba = reader.convert('RGBA').resize((64, 64), Image.Resampling.BILINEAR)
                    black = Image.new('RGBA', rgba.size, (0, 0, 0, 255))
                    thumbs[index] = Image.alpha_composite(black, rgba).convert('RGB')
            def distance(a, b):
                return sum(ImageStat.Stat(ImageChops.difference(thumbs[a], thumbs[b])).mean) / 3
            choices = []
            for a in range(first, last):
                if starts[a] > item['moveStartMs'] + 700:
                    break
                for b in range(a + 1, last + 1):
                    length = starts[b] - starts[a]
                    if 1000 <= length <= 2700:
                        choices.append((distance(a, b), -(b - a), a, b))
            _, _, begin, end = min(choices) if choices else (0, 0, first, last)
            frames, timing = [], []
            with Image.open(source) as reader:
                for index in range(begin, end + 1):
                    reader.seek(index)
                    # 与播放器相同的预乘alpha重采样；384是现有最大显示像素尺寸。
                    image = reader.convert('RGBA').convert('RGBa').resize((384, 384), Image.Resampling.LANCZOS).convert('RGBA')
                    frames.append(image)
                    stop = starts[index + 1] if index + 1 < len(starts) else item['durationMs']
                    timing.append(max(1, round(stop) - round(starts[index])))
            with tempfile.NamedTemporaryFile(dir=cache, suffix='.webp', delete=False) as temporary:
                temp = Path(temporary.name)
            try:
                frames[0].save(temp, format='WEBP', save_all=True, append_images=frames[1:],
                               duration=timing, loop=0, lossless=True, exact=True, method=1)
                os.replace(temp, cached)
            finally:
                temp.unlink(missing_ok=True)
            info = dict(sourceKey=release_source_key(item), sourceSha256=source_sha,
                        sha256=digest(cached), durationMs=sum(timing), size=384,
                        sourceFirstFrame=begin, sourceLastFrame=end,
                        seamDifferenceBefore=round(distance(first, last), 4),
                        seamDifferenceAfter=round(distance(begin, end), 4),
                        file='dragon-release/' + cached.name)
            info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
        destination = output / cached.name
        if not destination.exists():
            try:
                os.link(cached, destination)
            except OSError:
                shutil.copy2(cached, destination)
        elif digest(destination) != info['sha256']:
            raise ValueError('派生缓存同名但内容不符，拒绝覆盖：' + str(destination))
        profiles[item['id']] = info
        print(json.dumps(dict(id=item['id'], bytes=cached.stat().st_size, **info), ensure_ascii=False), flush=True)
    catalog = dict(schema=1, algorithm=ALGORITHM, profiles=profiles)
    with tempfile.NamedTemporaryFile(dir=output, suffix='.json', mode='w', encoding='utf-8', delete=False) as temporary:
        json.dump(catalog, temporary, ensure_ascii=False, indent=2)
        temporary.write('\n')
        name = temporary.name
    os.replace(name, output / 'catalog.json')
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.local/pet-build/release-loop-cache')
    args = parser.parse_args()
    prepare(args.assets_dir, args.cache_dir)


if __name__ == '__main__':
    main()
