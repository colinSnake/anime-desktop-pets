#!/usr/bin/env python3
"""用小尺寸合成素材验证 338 帧分段时间戳与原音轨复用，不运行超分模型。"""
from fractions import Fraction
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image

SPEC = importlib.util.spec_from_file_location('startup_upscale', Path(__file__).with_name('upscale-startup-video.py'))
UPSCALE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPSCALE)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), '需要 FFmpeg / FFprobe')
class StartupUpscaleTests(unittest.TestCase):
    def test_short_final_batch_keeps_338_frame_timeline_and_aac_packets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); inputs = root / 'input'; inputs.mkdir()
            for index in range(12):
                Image.new('RGB', (128, 72), (index * 10, 50, 100)).save(inputs / f'{index:06d}.png')
            with (root / 'encoding.log').open('w') as log:
                UPSCALE.encode_segment(inputs, root / 'normal.mp4', 12, log)
                UPSCALE.encode_segment(inputs, root / 'last.mp4', 2, log)
            # 338 帧恰好留下不足一批的 2 帧，是曾导致 DTS 间隔变化的情形。
            listing = root / 'segments.txt'
            listing.write_text("file 'normal.mp4'\n" * 28 + "file 'last.mp4'\n")
            audio = root / 'audio.m4a'
            UPSCALE.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
                         '-t', '14.101', '-c:a', 'aac', audio])
            result = root / 'result.mp4'
            UPSCALE.run(['ffmpeg', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', listing,
                         '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', result])
            info = UPSCALE.probe(result)
            video = next(s for s in info['streams'] if s['codec_type'] == 'video')
            self.assertEqual(int(video['nb_frames']), 338)
            self.assertEqual(Fraction(video['avg_frame_rate']), 24)
            self.assertAlmostEqual(float(video['duration']), 338 / 24, places=5)
            packets = json.loads(UPSCALE.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                                             '-show_packets', '-show_entries', 'packet=pts,dts',
                                             '-of', 'json', result], capture_output=True, text=True).stdout)['packets']
            for key in ('pts', 'dts'):
                timestamps = [Fraction(p[key]) * Fraction(video['time_base']) for p in packets]
                self.assertEqual(timestamps, [Fraction(i, 24) for i in range(338)])
            self.assertEqual(UPSCALE.audio_hash(audio), UPSCALE.audio_hash(result))
            UPSCALE.run(['ffmpeg', '-v', 'error', '-xerror', '-i', result, '-f', 'null', '-'],
                        stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
