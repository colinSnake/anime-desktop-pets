#!/usr/bin/env python3
"""Measure competing animation decoders with real WebP and offscreen Qt."""
import argparse
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def percentile(values, fraction):
    if not values:
        return 0.
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pets', type=int, choices=(1, 2, 3), required=True)
    parser.add_argument('--switches', type=int, default=4)
    parser.add_argument('--interval', type=float, default=1.6)
    parser.add_argument('--priority', choices=('current', 'fifo'), default='current',
                        help='compare requested-frame priority with FIFO waiter order')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 2 <= args.switches <= 20 or not .5 <= args.interval <= 10:
        parser.error('switches must be 2–20 and interval must be 0.5–10 seconds')

    with tempfile.TemporaryDirectory(prefix='dragon-multi-bench-') as home:
        os.environ.update(HOME=home, BAILONG_DATA_DIR=home, QT_QPA_PLATFORM='offscreen',
                          BAILONG_CODEX='/usr/bin/false')
        sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
        import psutil
        from PySide6.QtCore import QTimer, Qt
        from PySide6.QtWidgets import QApplication
        from dragon_frames import AnimationFrameStore, AnimationResourceBudget, LazyAnimationFrames
        from dragon_playback import PresentationClock

        assets = ROOT / '.local/pet-build/source/outputs/白龙桌宠素材'
        manifest = json.loads((assets / '素材清单.json').read_text())
        items = [manifest['idle'], *manifest['variants'][:4], *manifest['additionalIdleAnimations'][:2]]
        paths = [assets / (item.get('playbackFile') or item['file'].replace('.webm', '.webp'))
                 for item in items]
        app = QApplication([])
        budget = AnimationResourceBudget()
        if args.priority == 'fifo':
            acquire = budget.acquire_decode_slot
            budget.acquire_decode_slot = lambda _priority, valid: acquire(lambda: 0, valid)
        stores = [AnimationFrameStore(resource_budget=budget) for _ in range(args.pets)]
        process = psutil.Process()
        cpu_start = process.cpu_times()
        rss_initial = process.memory_info().rss
        state = [dict(group=-1, frames=None, clock=None, first=None, requested=None,
                      waiting_ticks=0, stalled_ticks=0, presented=0, last_index=None)
                 for _ in stores]
        latencies, gaps, callbacks = [], [], []
        started = time.monotonic()
        last_tick = None
        peak_rss = rss_initial
        timer = QTimer()
        timer.setTimerType(Qt.TimerType.PreciseTimer)
        timer.setInterval(16)

        def tick():
            nonlocal last_tick, peak_rss
            now = time.monotonic()
            elapsed = now - started
            if elapsed >= args.switches * args.interval:
                timer.stop()
                app.quit()
                return
            if last_tick is not None:
                gaps.append((now - last_tick) * 1000)
            last_tick = now
            begin = time.perf_counter()
            group = int(elapsed / args.interval)
            for number, (store, current) in enumerate(zip(stores, state)):
                if current['group'] != group:
                    item_index = (group + number) % len(items)
                    item = items[item_index]
                    frames = LazyAnimationFrames(store, paths[item_index], 512)
                    clock = PresentationClock(frames.durations_ms, item['durationMs'] / 1000, now)
                    store.activate(frames.path, 512, len(frames))
                    current.update(group=group, frames=frames, clock=clock, first=None,
                                   requested=now, last_index=None)
                frames, clock = current['frames'], current['clock']

                def ready(index):
                    frames.request(index)
                    return frames.ready(index) is not None

                clock.advance(now, ready)
                if clock.waiting:
                    current['waiting_ticks'] += 1
                elif current['first'] is None:
                    current['first'] = now
                    latencies.append((now - current['requested']) * 1000)
                if clock.stalled:
                    current['stalled_ticks'] += 1
                if not clock.waiting and current['last_index'] != clock.index:
                    current['presented'] += 1
                    current['last_index'] = clock.index
            callbacks.append((time.perf_counter() - begin) * 1000)
            peak_rss = max(peak_rss, process.memory_info().rss)

        timer.timeout.connect(tick)
        timer.start()
        try:
            app.exec()
            cpu_end = process.cpu_times()
            report = dict(
                scope='真实 WebP，512px，Qt offscreen，同步换片；非真实桌面或长期资源验收',
                pets=args.pets, switches=args.switches, intervalSeconds=args.interval,
                decodePriority=args.priority,
                expectedFirstFrames=args.pets * args.switches, firstFrames=len(latencies),
                firstFrameMs=dict(median=percentile(latencies, .5), p95=percentile(latencies, .95),
                                  max=max(latencies, default=0.), samples=latencies),
                waitingTicks=sum(entry['waiting_ticks'] for entry in state),
                stalledTicks=sum(entry['stalled_ticks'] for entry in state),
                distinctPresentedFrames=sum(entry['presented'] for entry in state),
                callbackMs=dict(median=statistics.median(callbacks), p95=percentile(callbacks, .95),
                                max=max(callbacks, default=0.)),
                timerGapMs=dict(p95=percentile(gaps, .95), max=max(gaps, default=0.)),
                initialRSSMiB=rss_initial / 1024**2, peakRSSMiB=peak_rss / 1024**2,
                cpuSeconds=(cpu_end.user + cpu_end.system) - (cpu_start.user + cpu_start.system),
                imageBudgetMiB=budget.image_bytes / 1024**2,
                pixmapBudgetMiB=budget.pixmap_bytes / 1024**2,
                cachedImageMiB=sum(store.cached_bytes for store in stores) / 1024**2,
                cachedPixmapMiB=sum(store.pixmap_bytes for store in stores) / 1024**2,
                storeStats=[dict(store.stats) for store in stores])
        finally:
            for store in stores:
                store.close()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
