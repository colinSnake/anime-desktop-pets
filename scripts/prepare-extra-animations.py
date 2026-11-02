#!/usr/bin/env python3
"""本地提取 10 个扩展动作，保留 alpha 转 WebP 并逐帧审核；不安装、不启动桌宠。"""
import argparse
import binascii
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARCHIVE = ROOT / '.local/animation-sources/bailong-desktop-pet-v0.5.1-windows-x64-webm.zip'
DEFAULT_OUT = ROOT / '.local/animation-sources/jingh12312-v0.5.1-extra'
EXPECTED_BYTES = 236968505
EXPECTED_SHA256 = '4b636bf1e92a82a798b01be09cbd658cbfc46c548dd1a38acee31368b9c78580'
PREFIX = 'BailongPet/outputs/白龙桌宠素材/'
EXTRA_IDS = ('idle03', 'idle04', 'idle05', 'idle06', 'move01left',
             'move01right', 'move02', 'move02left', 'move03left', 'move03right')


def sha256(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def extract(archive, out):
    if archive.stat().st_size != EXPECTED_BYTES or sha256(archive) != EXPECTED_SHA256:
        raise ValueError('压缩包大小或 SHA-256 与已检查的 v0.5.1 不符；不提取未知包')
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        manifest = json.loads(bundle.read(PREFIX + '素材清单.json').decode('utf-8-sig'))
        all_items = manifest['additionalIdleAnimations'] + manifest['movementAnimations']
        items = [item for item in all_items if item['id'] in EXTRA_IDS]
        if len(items) != len(EXTRA_IDS) or {item['id'] for item in items} != set(EXTRA_IDS):
            raise ValueError('新增动作清单缺失或重复')
        for item in items:
            relative = PurePosixPath(item['playbackFile'])
            if relative.is_absolute() or '..' in relative.parts or relative.suffix != '.webm':
                raise ValueError('非法素材路径：' + str(relative))
            info = bundle.getinfo(PREFIX + str(relative))
            if info.file_size > 32 * 1024 * 1024:
                raise ValueError('单动作超过 32MiB 提取上限')
            data = bundle.read(info)
            if binascii.crc32(data) & 0xffffffff != info.CRC:
                raise ValueError('CRC 校验失败：' + item['id'])
            target = out / (item['id'] + '.webm')
            if target.exists() and target.read_bytes() != data:
                raise ValueError('已有文件不同，拒绝覆盖：' + str(target))
            if not target.exists():
                target.write_bytes(data)
        (out / 'source-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return items


def probe(path, ffprobe):
    result = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate:stream_tags=alpha_mode:format=duration:frame=best_effort_timestamp_time',
        '-of', 'json', str(path)], check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    stream = data['streams'][0]
    width, height = stream['width'], stream['height']
    times = [round(float(frame['best_effort_timestamp_time']) * 1000) for frame in data['frames']]
    total = round(float(data['format']['duration']) * 1000)
    if stream.get('tags', {}).get('alpha_mode') != '1':
        raise ValueError('源视频未声明透明通道：' + str(path))
    if not times or times[0] != 0 or any(b <= a for a, b in zip(times, times[1:])) or total <= times[-1]:
        raise ValueError('帧时间戳不单调或非零起点：' + str(path))
    if width <= 0 or height <= 0 or width > 2048 or height > 2048:
        raise ValueError('异常素材尺寸')
    if width * height * 4 * len(times) > 768 * 1024 * 1024:
        raise ValueError('单动作解码像素超过 768MiB 上限')
    durations = [b - a for a, b in zip(times, times[1:] + [total])]
    return width, height, durations, total


def read_exact(handle, size):
    chunks = []
    remaining = size
    while remaining:
        part = handle.read(remaining)
        if not part:
            raise ValueError('FFmpeg 输出帧被截断')
        chunks.append(part)
        remaining -= len(part)
    return b''.join(chunks)


def decode(path, width, height, count, ffmpeg):
    from PIL import Image
    frames = []
    # 强制 libvpx-vp9，否则默认 VP9 解码可能丢弃 WebM 的独立 alpha。
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen([ffmpeg, '-hide_banner', '-loglevel', 'error', '-threads', '2',
            '-c:v', 'libvpx-vp9', '-i', str(path), '-map', '0:v:0', '-an',
            '-fps_mode', 'passthrough', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
            stdout=subprocess.PIPE, stderr=errors)
        try:
            for _ in range(count):
                frames.append(Image.frombytes('RGBA', (width, height), read_exact(proc.stdout, width * height * 4)))
            if proc.stdout.read(1):
                raise ValueError('解码帧数多于源时间戳数量')
            code = proc.wait(timeout=60)
            if code:
                errors.seek(0)
                raise ValueError('FFmpeg 解码失败：' + errors.read().decode(errors='replace')[-2000:])
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
    return frames


def visible_digest(frame):
    from PIL import Image
    frame = frame.convert('RGBA')
    black = Image.new('RGBA', frame.size, (0, 0, 0, 255))
    black.alpha_composite(frame)
    return hashlib.sha256(black.convert('RGB').tobytes() + frame.getchannel('A').tobytes()).hexdigest()


def timeline(frames, durations):
    result = []
    for frame, duration in zip(frames, durations):
        digest = visible_digest(frame)
        if result and result[-1][0] == digest:
            result[-1][1] += duration
        else:
            result.append([digest, duration])
    return result


def convert_one(item, out, ffmpeg, ffprobe):
    from PIL import Image
    source = out / (item['id'] + '.webm')
    width, height, durations, total = probe(source, ffprobe)
    if abs(total - item['durationMs']) > 85:
        raise ValueError('源清单时长与实际视频相差超过两帧：' + item['id'])
    frames = decode(source, width, height, len(durations), ffmpeg)
    source_timeline = timeline(frames, durations)
    alpha = [frame.getchannel('A').getextrema() for frame in frames]
    if any(lo != 0 or hi != 255 for lo, hi in alpha):
        raise ValueError('源解码缺少透明/不透明像素：' + item['id'])
    webp = out / 'webp' / (item['id'] + '.webp')
    webp.parent.mkdir(exist_ok=True)
    partial = webp.with_suffix('.partial.webp')
    # lossless=True 保持像素无损；quality/method 在此控制压缩努力，避免长时间阻塞准备。
    try:
        frames[0].save(partial, format='WEBP', save_all=True, append_images=frames[1:],
            duration=durations, loop=0, lossless=True, quality=80, method=0,
            background=(0, 0, 0, 0), kmin=3, kmax=5)
        del frames
        with Image.open(partial) as encoded:
            decoded, encoded_durations = [], []
            for index in range(encoded.n_frames):
                encoded.seek(index)
                decoded.append(encoded.convert('RGBA'))
                encoded_durations.append(round(encoded.info['duration']))
            if timeline(decoded, encoded_durations) != source_timeline:
                raise ValueError('转码后可见像素、透明度或帧时序与源素材不一致：' + item['id'])
            if len(source_timeline) < 2:
                raise ValueError('不是有效多帧动画：' + item['id'])
            count = encoded.n_frames
        partial.replace(webp)
        preview_frames = []
        elapsed = 0
        next_time = 0
        for frame, duration in zip(decoded, encoded_durations):
            if elapsed >= next_time:
                small = frame.resize((224, 224), Image.Resampling.LANCZOS)
                canvas = Image.new('RGBA', small.size, '#211d30')
                canvas.alpha_composite(small)
                preview_frames.append(canvas.convert('RGB'))
                next_time = elapsed + 1000 / 12
            elapsed += duration
        previews = out / 'previews'
        previews.mkdir(exist_ok=True)
        preview_frames[0].save(previews / (item['id'] + '.gif'), save_all=True,
            append_images=preview_frames[1:], duration=round(total / len(preview_frames)),
            loop=0, disposal=2)
        # 保留首/1/3/2/3/尾帧，便于查看起步、主体和收尾，不伪称连续衔接已修好。
        samples = []
        for index in [0, count // 3, count * 2 // 3, count - 1]:
            small = decoded[index].resize((192, 192), Image.Resampling.LANCZOS)
            bg = Image.new('RGBA', small.size, '#211d30')
            bg.alpha_composite(small)
            samples.append((index, bg.convert('RGB')))
        record = {'id': item['id'], 'name': item['name'], 'sourceBytes': source.stat().st_size,
            'sourceSha256': sha256(source), 'webp': str(webp.relative_to(out)),
            'webpBytes': webp.stat().st_size, 'webpSha256': sha256(webp),
            'size': [width, height], 'sourceFrames': len(durations), 'decodedFrames': count,
            'distinctVisibleFrames': len({entry[0] for entry in source_timeline}),
            'durationMs': sum(encoded_durations), 'sourceManifestDurationMs': item['durationMs'],
            'minFrameMs': min(encoded_durations), 'maxFrameMs': max(encoded_durations),
            'alphaRange': [min(a[0] for a in alpha), max(a[1] for a in alpha)],
            'losslessVisiblePixelsAndTimingVerified': True}
        return record, samples
    finally:
        if partial.exists():
            partial.unlink()


def contact_sheet(rows, dest):
    from PIL import Image, ImageDraw
    width = 4 * 204 + 16
    canvas = Image.new('RGB', (width, len(rows) * 238 + 24), '#171320')
    draw = ImageDraw.Draw(canvas)
    for row_index, (identifier, samples) in enumerate(rows):
        top = 16 + row_index * 238
        draw.text((16, top), identifier, fill='white')
        for column, (index, image) in enumerate(samples):
            left = 16 + column * 204
            canvas.paste(image, (left, top + 22))
            draw.text((left, top + 216), f'frame {index}', fill='#d0c6de')
    canvas.save(dest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    args = parser.parse_args()
    if not args.ffmpeg or not args.ffprobe:
        parser.error('需要支持 libvpx-vp9 的 FFmpeg/FFprobe，以及当前 Python 环境中的 Pillow')
    try:
        out = args.out.resolve()
        # 审阅产物只放在本工程 .local，拒绝覆盖源码、原始 helper 或正常资源目录。
        staging = (ROOT / '.local/animation-sources').resolve()
        if not out.is_relative_to(staging) or out == staging:
            raise ValueError('--out 必须是本工程 .local/animation-sources 的子目录')
        if out.is_relative_to(args.archive.resolve()):
            raise ValueError('输出目录不可指向输入文件')
        items = extract(args.archive, out)
        reports, idle_rows, move_rows = [], [], []
        for item in items:
            print('开始转码：' + item['id'] + ' ' + item['name'], flush=True)
            record, samples = convert_one(item, out, args.ffmpeg, args.ffprobe)
            reports.append(record)
            (idle_rows if item['id'].startswith('idle') else move_rows).append((item['id'], samples))
            print(f"已逐帧校验 {item['id']}: {record['decodedFrames']} 帧 / {record['durationMs']}ms / {record['webpBytes']} bytes", flush=True)
        contact_sheet(idle_rows, out / 'previews/idle-contact-sheet.png')
        contact_sheet(move_rows, out / 'previews/movement-contact-sheet.png')
        source = {'repository': 'jingh12312-rgb/bailong-desktop-pet', 'release': 'v0.5.1',
            'archive': args.archive.name, 'archiveSha256': EXPECTED_SHA256}
        by_id = {x['id']: x for x in reports}
        extension = {'schema': 1, 'source': source, 'additionalIdleAnimations': [], 'movementAnimations': []}
        for item in items:
            amended = dict(item, sourceFile=item['file'], file=by_id[item['id']]['webp'],
                playbackFile=by_id[item['id']]['webp'], durationMs=by_id[item['id']]['durationMs'])
            extension['additionalIdleAnimations' if item['id'].startswith('idle') else 'movementAnimations'].append(amended)
        audit = {'schema': 1, 'source': source,
            'scope': 'Local staging and offline decode only; not installed or original/generated artwork; no continuity fix or desktop acceptance.',
            'actionCount': len(reports), 'decodedFrames': sum(x['decodedFrames'] for x in reports),
            'webpBytes': sum(x['webpBytes'] for x in reports), 'actions': reports}
        for filename, data in [('extension-manifest.json', extension), ('conversion-audit.json', audit)]:
            (out / filename).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'out': str(out), 'actions': len(reports), 'frames': audit['decodedFrames'], 'installed': False}, ensure_ascii=False), flush=True)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        parser.exit(1, '扩展动画准备失败：' + str(error) + '\n')


if __name__ == '__main__':
    main()
