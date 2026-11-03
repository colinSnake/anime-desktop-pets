#!/usr/bin/env python3
"""在本地将 1080p/24fps 开机视频超分到 4K；仅 --install 才替换项目素材。"""
import argparse
import fcntl
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/video-upscale'
MEDIA = ROOT / 'resources/media/startup.mp4'
MODEL = 'realesr-animevideov3'
RELEASE = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip'
ARCHIVE_SHA256 = 'e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(command, **kwargs):
    return subprocess.run([str(arg) for arg in command], check=True, **kwargs)


def probe(path):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format',
                          '-of', 'json', path], capture_output=True, text=True).stdout)


def audio_hash(path):
    return run(['ffmpeg', '-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy',
                '-f', 'hash', '-hash', 'sha256', '-'], capture_output=True, text=True).stdout.strip()


def read_frame(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            break
        chunks.extend(chunk)
    if chunks and len(chunks) != size:
        raise RuntimeError('原视频解码返回不完整的帧')
    return bytes(chunks)


def encode_segment(inputs, destination, frame_count, log):
    # 各批都不使用 B 帧，末批不足 12 帧时仍保持相同的解码延迟。
    run(['ffmpeg', '-v', 'error', '-y', '-framerate', '24', '-start_number', '0',
         '-i', inputs / '%06d.png', '-frames:v', str(frame_count),
         '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,setsar=1',
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-threads', '4', '-bf', '0',
         '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709',
         '-color_trc', 'bt709', destination], stdout=log, stderr=subprocess.STDOUT)


def install(output, source_hash, backup, report):
    # 不覆盖推理期间被另一个流程修改的素材或来源清单。
    if digest(MEDIA) != source_hash:
        raise RuntimeError('项目视频在处理期间已变化；已保留完整输出，不替换素材')
    manifest_path = ROOT / 'resources/assets.local.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        'scope': 'local private development; not a redistribution license', 'assets': []}
    entries = manifest.setdefault('assets', [])
    previous = next((entry for entry in entries if entry.get('file') == 'media/startup.mp4'), None)
    report['previous_asset'] = previous
    entry = {'file': 'media/startup.mp4', 'source': str(backup),
             'sha256': report['output_sha256'], 'bytes': output.stat().st_size,
             'derivation': {'method': MODEL + '-x2', 'report': str(output.with_suffix('.json')),
                            'source_sha256': source_hash}}
    entries[:] = [item for item in entries if item.get('file') != 'media/startup.mp4'] + [entry]
    with tempfile.NamedTemporaryFile(dir=MEDIA.parent, suffix='.mp4', delete=False) as tmp:
        staged = Path(tmp.name)
    try:
        shutil.copy2(output, staged)
        os.replace(staged, MEDIA)
    finally:
        staged.unlink(missing_ok=True)
    # 只修改启动视频条目，保留桌宠图片等其它素材的来源。
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    report['installed_to'] = str(MEDIA)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=MEDIA)
    parser.add_argument('--output', type=Path, default=BASE / 'startup-4k.mp4')
    parser.add_argument('--tool', type=Path, default=BASE / 'tool/realesrgan-ncnn-vulkan')
    parser.add_argument('--batch-size', type=int, default=12)
    parser.add_argument('--install', action='store_true', help='验证成功后备份原片并替换项目启动素材')
    args = parser.parse_args()
    source = args.input.expanduser().resolve(strict=True)
    output = args.output.expanduser().resolve()
    tool = args.tool.expanduser().resolve(strict=True)
    model_dir = tool.parent / 'models'
    if not 1 <= args.batch_size <= 12:
        parser.error('--batch-size 必须在 1–12 之间，以限制临时帧的磁盘占用')
    for command in ('ffmpeg', 'ffprobe'):
        if not shutil.which(command):
            parser.error('缺少工具：' + command)
    for name in (MODEL + '-x2.bin', MODEL + '-x2.param'):
        if not (model_dir / name).is_file():
            parser.error('缺少模型：' + str(model_dir / name))
    if not os.access(tool, os.X_OK):
        parser.error('超分工具不可执行：' + str(tool))
    if output == source or output == MEDIA.resolve():
        parser.error('输出需独立于原素材；使用 --install 在验证后替换项目素材')
    output.parent.mkdir(parents=True, exist_ok=True)
    with (output.parent / (output.name + '.lock')).open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('同一输出正在处理')
        if output.exists() or output.with_suffix('.pending.mp4').exists():
            parser.error('输出已存在，拒绝覆盖：' + str(output))
        if shutil.disk_usage(output.parent).free < 512 * 1024**2:
            parser.error('需要至少 512 MiB 可用临时空间')
        execute(args, source, output, tool, model_dir)


def execute(args, source, output, tool, model_dir):
    started = time.monotonic()
    info = probe(source)
    video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
    audios = [stream for stream in info['streams'] if stream['codec_type'] == 'audio']
    if (video['width'], video['height']) != (1920, 1080):
        raise RuntimeError('本入口只处理 1920×1080 的原开机动画，避免重复超分')
    if Fraction(video['r_frame_rate']) != 24 or Fraction(video['avg_frame_rate']) != 24:
        raise RuntimeError('本入口只处理恒定 24 fps 的原开机动画')
    if len(audios) != 1 or audios[0]['codec_name'] != 'aac':
        raise RuntimeError('原片须包含一条 AAC 音轨，以保持原音频压缩数据')
    expected = int(video['nb_frames'])
    BASE.mkdir(parents=True, exist_ok=True)
    source_hash = digest(source)
    backup = BASE / 'startup-original-1080p.mp4'
    if backup.exists() and digest(backup) != source_hash:
        raise RuntimeError('原片备份已存在且内容不同，拒绝覆盖')
    if not backup.exists():
        shutil.copy2(source, backup)
    if digest(backup) != source_hash:
        raise RuntimeError('原片备份校验失败')
    # 后续只读稳定备份，避免其它会话替换输入导致混入不同版本的帧。
    snapshot = backup
    report = {'source': str(source), 'source_backup': str(backup), 'source_sha256': source_hash,
              'source_probe': info, 'tool_release': RELEASE, 'tool_archive_sha256': ARCHIVE_SHA256,
              'tool_sha256': digest(tool), 'model': MODEL + '-x2',
              'model_sha256': {p.name: digest(p) for p in sorted(model_dir.glob(MODEL + '-x2.*'))},
              'fps': 24, 'frame_count': expected, 'batch_size': args.batch_size, 'tile': 256,
              'encoding': 'H.264 CRF18 medium, bf=0, yuv420p bt709; AAC stream copy', 'batches': []}
    log_path = output.with_suffix('.log')
    with tempfile.TemporaryDirectory(prefix='frames-', dir=output.parent) as tmp, log_path.open('w') as log:
        work = Path(tmp)
        inputs = work / 'input'; inputs.mkdir()
        outputs = work / 'output'; outputs.mkdir()
        segments = []
        decoder = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', str(snapshot), '-map', '0:v:0',
                                    '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
                                   stdout=subprocess.PIPE, stderr=log)
        count = 0
        try:
            while count < expected:
                size = min(args.batch_size, expected - count)
                for index in range(size):
                    raw = read_frame(decoder.stdout, 1920 * 1080 * 3)
                    if not raw:
                        raise RuntimeError('原片在预期帧数前结束')
                    Image.frombytes('RGB', (1920, 1080), raw).save(inputs / f'{index:06d}.png')
                before = time.monotonic()
                run([tool, '-i', inputs, '-o', outputs, '-s', '2', '-n', MODEL, '-m', model_dir,
                     '-t', '256', '-j', '1:1:1', '-f', 'png'], stdout=log, stderr=subprocess.STDOUT)
                seconds = time.monotonic() - before
                for index in range(size):
                    with Image.open(outputs / f'{index:06d}.png') as image:
                        if image.size != (3840, 2160):
                            raise RuntimeError('超分输出尺寸不符')
                segment = work / f'segment-{len(segments):03d}.mp4'
                encode_segment(inputs, segment, size, log)
                segments.append(segment)
                count += size
                report['batches'].append({'end_frame': count, 'frames': size, 'inference_seconds': round(seconds, 3)})
                # 每批编码后立即回收 PNG，不积累整段 4K 帧。
                for directory in (inputs, outputs):
                    for frame in directory.glob('*.png'):
                        frame.unlink()
                print(f'超分并编码 {count}/{expected} 帧；本批推理 {seconds:.1f}s；总耗时 {time.monotonic()-started:.1f}s', flush=True)
            if read_frame(decoder.stdout, 1920 * 1080 * 3):
                raise RuntimeError('原片实际帧数超过清单')
            if decoder.wait() != 0:
                raise RuntimeError('FFmpeg 原片解码失败；见日志')
        finally:
            decoder.stdout.close()
            if decoder.poll() is None:
                decoder.terminate()
                decoder.wait()
        listing = work / 'segments.txt'
        # 文件名由脚本生成，不将用户输入拼接到 concat 语法。
        listing.write_text(''.join(f"file '{segment.name}'\n" for segment in segments))
        staged = work / 'startup-4k.mp4'
        run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', listing,
             '-i', snapshot, '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1',
             '-c', 'copy', '-movflags', '+faststart', staged], stdout=log, stderr=subprocess.STDOUT)
        # 校验前先保留完整候选视频；失败时也可诊断或修复，不丢弃已完成推理。
        candidate = output.with_suffix('.pending.mp4')
        os.replace(staged, candidate)
        staged = candidate
        output_info = probe(staged)
        report['candidate_probe'] = output_info
        output.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        actual = next(s for s in output_info['streams'] if s['codec_type'] == 'video')
        if (actual['width'], actual['height'], int(actual['nb_frames']), Fraction(actual['avg_frame_rate'])) != (3840, 2160, expected, 24):
            raise RuntimeError('成片尺寸、帧数或帧率校验失败')
        packets = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                                  '-show_packets', '-show_entries', 'packet=pts', '-of', 'json', staged],
                                 capture_output=True, text=True).stdout)['packets']
        timestamps = sorted(Fraction(packet['pts']) * Fraction(actual['time_base']) for packet in packets)
        if timestamps != [Fraction(index, 24) for index in range(expected)]:
            raise RuntimeError('成片呈现时间戳不是连续的 24 fps')
        if abs(float(actual['duration']) - float(video['duration'])) > 1 / 24:
            raise RuntimeError('成片视频时长不符')
        if abs(float(output_info['format']['duration']) - float(info['format']['duration'])) > 1 / 24:
            raise RuntimeError('成片整体时长不符')
        run(['ffmpeg', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', staged,
             '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], stdout=log, stderr=subprocess.STDOUT)
        original_audio = audio_hash(snapshot)
        if audio_hash(staged) != original_audio:
            raise RuntimeError('成片音轨与原音轨压缩数据哈希不符')
        report.update(output_probe=output_info, output_sha256=digest(staged),
                      audio_packet_hash=original_audio, presentation_timestamps_validated=True, seconds=round(time.monotonic()-started, 3))
        if output.exists():
            raise RuntimeError('处理期间输出路径已被占用，拒绝覆盖')
        os.replace(staged, output)
    report_path = output.with_suffix('.json')
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if args.install:
        install(output, source_hash, backup, report)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f'完成：{output}；{output.stat().st_size / 1024**2:.1f} MiB；{report["seconds"]:.1f}s', flush=True)
    print('验证：3840×2160 / 24fps / 全帧数与时长一致 / 完整解码 / AAC 原压缩数据一致', flush=True)
    if args.install:
        print(f'项目素材已替换；原片保留于 {backup}', flush=True)


if __name__ == '__main__':
    main()
