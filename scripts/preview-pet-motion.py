#!/usr/bin/env python3
"""离屏合成真实角色帧与移动轨迹；不是桌面实录，不启动 Codex。"""
import io
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.local/pet-build/previews/motion'
OUT.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix='dragon-motion-preview-') as home:
    os.environ.update(HOME=home, BAILONG_DATA_DIR=home, QT_QPA_PLATFORM='offscreen',
                      BAILONG_CODEX='/usr/bin/false')
    sys.path[:0] = [str(ROOT / 'apps/pet-runtime/bailong'), str(ROOT / '.local/pet-build/generated-source/app')]
    from PySide6.QtCore import QBuffer, QIODevice
    from PySide6.QtWidgets import QApplication
    from PIL import Image, ImageDraw, ImageFont
    from pet import Pet
    from dragon_behavior import Motion

    app = QApplication([])
    pet = Pet()
    pet.tick.stop()
    pet.behavior.close()
    font = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 17)
    small = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 12)

    def wait_frame(index):
        pet.frames.request(index)
        deadline = time.monotonic() + 10
        while pet.frames.ready(index) is None:
            app.processEvents()
            if time.monotonic() > deadline:
                raise TimeoutError('离屏动画取帧超时')
            time.sleep(.002)
        pet.index = index

    for filename, label, motion in [
        ('drag-release.gif', 'Drag release / 3 fading hops', Motion('settle', (190, 164), 88, 50, 1.25)),
        ('autonomous-motion.gif', 'Autonomous / double hop', Motion('double-hop', (230, 164), 36, 52, 1.9)),
    ]:
        pet.play(pet.idles[0], 'idle')
        frames = []
        for frame_index in range(round((motion.duration + .6) * 24)):
            seconds = frame_index / 24
            index = int((seconds % (pet.current['durationMs'] / 1000)) /
                        (pet.current['durationMs'] / 1000) * len(pet.frames))
            wait_frame(index)
            snapshot = pet.snapshot_frame()
            buffer = QBuffer()
            buffer.open(QIODevice.OpenModeFlag.WriteOnly)
            snapshot.save(buffer, 'PNG')
            sprite = Image.open(io.BytesIO(bytes(buffer.data()))).convert('RGBA')
            canvas = Image.new('RGB', (680, 450), '#1b1d2a')
            draw = ImageDraw.Draw(canvas)
            draw.text((24, 20), label, font=font, fill='#eeeafa')
            draw.text((24, 47), 'Offscreen composite / existing art + window trajectory', font=small, fill='#a5a1b9')
            draw.line((28, 414, 652, 414), fill='#555168', width=1)
            x, y = motion.position(seconds / motion.duration)
            canvas.paste(sprite, (x, y), sprite)
            frames.append(canvas)
        frames[0].save(OUT / filename, save_all=True, append_images=frames[1:],
                       duration=42, loop=0, optimize=False)
        print(OUT / filename)
    pet.close()
