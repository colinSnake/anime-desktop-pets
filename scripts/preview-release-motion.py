#!/usr/bin/env python3
"""实际 Qt 呈现与松手调度的离屏 GIF；临时用户目录，不启动真实桌面或网络。"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HOME = tempfile.TemporaryDirectory(prefix='dragon-release-preview-')
os.environ.update(HOME=HOME.name, BAILONG_DATA_DIR=HOME.name,
                  QT_QPA_PLATFORM='offscreen', BAILONG_CODEX='/usr/bin/false')
sys.path[:0] = [str(ROOT / 'apps/pet-runtime/bailong'), str(ROOT / '.local/pet-build/generated-source/app')]
from PIL import Image, ImageDraw
from PySide6.QtCore import QPoint
from PySide6.QtGui import QImage
from PySide6.QtWidgets import QApplication
from pet import Pet


def main():
    app = QApplication.instance() or QApplication([])
    app.setQuitOnLastWindowClosed(False)
    out = ROOT / '.local/pet-build/previews/release'
    out.mkdir(parents=True, exist_ok=True)
    pet = Pet()
    pet.tick.stop();pet.visibility_timer.stop();pet.show()
    pet.behavior.enabled = False
    pet.behavior.motion_enabled = True
    pet.behavior.reduce_motion = lambda: False
    pet.behavior._check_motion_at = 0
    area = app.primaryScreen().availableGeometry()
    pet.move(QPoint(area.center().x() - pet.width() // 2, area.top() + 180))
    records = []
    try:
        for facing, vx, vy in [('right', 220, -260), ('left', -800, 0)]:
            pet.behavior.pause()
            pet.play(pet.manifest['dragAnimation'], 'drag')
            moment = pet.presentation.last
            pet.behavior.clock = lambda: moment
            frames, states = [], []

            def step():
                nonlocal moment
                clock = pet.presentation
                # 等待此次呈现所需帧，事件泵不会让正常动画 timer 运行。
                desired = clock.index if clock.waiting or clock.blending else clock.index_at(
                    clock.offset + min(clock.length, clock.elapsed + 1 / 30))
                pet.frames.request(desired)
                deadline = time.perf_counter() + 15
                while pet.frames.ready(desired) is None:
                    app.processEvents();time.sleep(.002)
                    if time.perf_counter() > deadline:
                        raise TimeoutError('预览解码超时')
                moment += 1 / 30
                with patch('pet.time.monotonic', return_value=moment):
                    pet.animate()
                image = pet.snapshot_frame().toImage().convertToFormat(QImage.Format.Format_RGBA8888)
                raw = image.bits().tobytes()
                rgba = Image.frombytes('RGBA', (image.width(), image.height()), raw)
                canvas = Image.new('RGBA', (640, 400), '#201a2c')
                x = 220 + pet.x() - origin.x();y = 110 + pet.y() - origin.y()
                canvas.alpha_composite(rgba, (x, y))
                draw = ImageDraw.Draw(canvas)
                phase = 'waiting' if pet.waiting_first_frame else ('blend' if pet.presentation.blending else pet.mode)
                draw.text((18, 18), f'{facing} / {pet.current["id"]} / {phase}', fill='white')
                frames.append(canvas.convert('RGB'))
                states.append({'action': pet.current['id'], 'phase': phase, 'x': pet.x(), 'y': pet.y()})

            origin = pet.pos()
            for _ in range(18):step()
            before = pet.displayed_canvas.toImage().copy()
            pet.behavior.drag_samples.clear()
            pet.behavior.drag_samples.extend([(moment - .1, origin.x() - vx * .1, origin.y() - vy * .1),
                                              (moment, origin.x(), origin.y())])
            with patch('pet.time.monotonic', return_value=moment):
                assert pet.behavior.release_drag()
            item = pet.current['id']
            identical = pet.snapshot_frame().toImage() == before
            assert identical
            for _ in range(300):
                step()
                if pet.mode == 'idle' and not pet.waiting_first_frame and not pet.presentation.blending:
                    break
            else:
                raise RuntimeError('动作未正常收尾')
            for _ in range(9):step()
            name = f'release-{facing}.gif'
            frames[0].save(out / name, save_all=True, append_images=frames[1:],
                           duration=33, loop=0, disposal=2)
            pick = [17, 18, 20, 25, len(frames) // 2, len(frames) - 1]
            sheet = Image.new('RGB', (960, 440), '#eeeeee')
            for n, index in enumerate(pick):
                image = frames[index].copy();image.thumbnail((320, 200))
                sheet.paste(image, ((n % 3) * 320, (n // 3) * 220))
                ImageDraw.Draw(sheet).text(((n % 3) * 320 + 8, (n // 3) * 220 + 202),
                                           f'frame {index} / {states[index]["phase"]}', fill='black')
            sheet.save(out / f'release-{facing}-contact.png')
            records.append({'file': name, 'action': item, 'frames': len(frames),
                            'releasePixelIdentity': identical, 'states': states})
            print('Preview', name, item, 'pixel identity:', identical, flush=True)
        (out / 'report.json').write_text(json.dumps({'scope': 'Actual offscreen Qt presenter; not desktop recording',
                                                    'actions': records}, ensure_ascii=False, indent=2) + '\n')
    finally:
        pet.close();app.processEvents();HOME.cleanup()


if __name__ == '__main__':
    main()
