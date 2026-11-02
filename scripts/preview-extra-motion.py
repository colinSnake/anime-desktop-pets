#!/usr/bin/env python3
"""新增移动素材与运行时轨迹的离屏合成预览；不是桌面录像。"""
from bisect import bisect_right
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
from dragon_behavior import ClipMotion
from PIL import Image, ImageDraw


def main():
    source = ROOT / '.local/animation-sources/jingh12312-v0.5.1-extra'
    manifest = json.loads((source / 'extension-manifest.json').read_text())
    out = ROOT / '.local/pet-build/previews/extra-motion'
    out.mkdir(parents=True, exist_ok=True)
    report = []
    for identifier in ['move01right', 'move02', 'move03right']:
        item = next(v for v in manifest['movementAnimations'] if v['id'] == identifier)
        flight = identifier.startswith('move03')
        motion = ClipMotion((240, 180), 180 if flight else (150 if identifier == 'move02' else 96),
                            64 if flight else 0, item['durationMs'] / 1000,
                            item['moveStartMs'] / 1000, item['moveStopMs'] / 1000)
        frames, timestamps, elapsed = [], [], 0
        with Image.open(source / item['playbackFile']) as image:
            for index in range(image.n_frames):
                image.seek(index)
                frames.append(image.convert('RGBA').resize((180, 180), Image.Resampling.LANCZOS))
                timestamps.append(elapsed)
                elapsed += image.info['duration']
        previews = []
        sample_count = round(motion.duration * 12)
        for sample in range(sample_count):
            t = sample / 12
            x, y = motion.position(t / motion.duration)
            canvas = Image.new('RGBA', (720, 380), '#201a2c')
            draw = ImageDraw.Draw(canvas)
            active = motion.move_start <= t < motion.move_stop
            draw.text((20, 16), f'{identifier} / {t:.2f}s / ' + ('moving' if active else 'start / finish'), fill='white')
            draw.line((40, 360, 680, 360), fill='#625272')
            frame_index = max(0, bisect_right(timestamps, t * 1000) - 1)
            canvas.alpha_composite(frames[frame_index], (x, y))
            previews.append(canvas.convert('RGB'))
        previews[0].save(out / (identifier + '.gif'), save_all=True, append_images=previews[1:],
                         duration=round(motion.duration * 1000 / len(previews)), loop=0, disposal=2)
        report.append({'id': identifier, 'durationMs': item['durationMs'], 'moveStartMs': item['moveStartMs'],
                       'moveStopMs': item['moveStopMs'], 'travel': motion.travel, 'height': motion.height})
        print('Preview', identifier, flush=True)
    (out / 'report.json').write_text(json.dumps({'scope': 'Offline source frames + actual ClipMotion; not a desktop recording',
                                                'actions': report}, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
