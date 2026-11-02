#!/usr/bin/env python3
"""真实WebP离屏弹跳诊断；禁止正常桌面启动与账号访问。"""
import argparse
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=4.)
    parser.add_argument('--inject-stalls', action='store_true', help='每800ms注入120ms未就绪，仅用于可重复对比')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--kind', choices=('random','run','flight'), default='random')
    parser.add_argument('--warm-drag', choices=('idle','run','flight'), default='idle')
    parser.add_argument('--size-percent', type=int, choices=(50,100,150), default=100)
    parser.add_argument('--original-release-clips', action='store_true', help='仅本次诊断禁用派生缓存，不改源素材')
    parser.add_argument('--hold-spring', action='store_true', help='对照时统一弹性系数.92，避免短轨迹隐藏缺帧')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 30:
        parser.error('--seconds must be between 1 and 30')
    with tempfile.TemporaryDirectory(prefix='dragon-release-bench-') as home:
        os.environ.update(HOME=home, BAILONG_DATA_DIR=home, QT_QPA_PLATFORM='offscreen', BAILONG_CODEX='/usr/bin/false')
        sys.path[:0] = [str(ROOT/'apps/pet-runtime/bailong'), str(ROOT/'.local/pet-build/generated-source/app')]
        from PySide6.QtCore import QPoint, QTimer, Qt
        from PySide6.QtWidgets import QApplication
        import dragon_behavior
        if args.original_release_clips:
            dragon_behavior.release_clip = lambda item, catalog: item
        from pet import Pet
        app = QApplication([])
        app.setQuitOnLastWindowClosed(False)
        pet = Pet()
        pet.tick.stop()
        pet.set_size_percent(args.size_percent)
        pet.show()
        app.processEvents()
        behavior = pet.behavior
        behavior.enabled = False
        behavior.motion_enabled = True
        behavior.reduce_motion = lambda: False
        behavior._check_motion_at = 0
        pet.bubble.hide()
        area = app.primaryScreen().availableGeometry()
        pet.move(QPoint(area.center().x()-pet.width()//2, area.bottom()+1-pet.height()-120))
        if args.warm_drag != 'idle':
            prefix = 'move02' if args.warm_drag == 'run' else 'move03'
            item = next(v for v in pet.manifest['movementAnimations']
                        if v['id'].startswith(prefix) and v['sourceFacing']=='right')
            pet.play(item,'drag',start_ms=item['moveStartMs']+500)
            deadline=time.monotonic()+15
            while pet.presentation.waiting or pet.presentation.blending or pet.presentation.elapsed<.1:
                app.processEvents();pet.animate();time.sleep(.005)
                if time.monotonic()>deadline:raise RuntimeError('拖拽预热超时')
        if args.kind!='random':
            prefix='move02' if args.kind=='run' else 'move03'
            behavior.rng.choice=lambda values:next(v for v in values if v['id'].startswith(prefix))
        now = time.monotonic()
        behavior.drag_samples.clear()
        behavior.drag_samples.extend([(now-.1, pet.x()-40, pet.y()+50), (now, pet.x(), pet.y())])
        behavior.drag_distance = 65.
        if not behavior.release_drag():
            raise RuntimeError('离屏甩动启动失败')
        spring = behavior.release_spring
        release_clock=pet.presentation
        selected=pet.current
        if args.hold_spring:spring.restitution=.92
        start = time.monotonic()
        gaps, callbacks, pauses = [], [], []
        state = dict(last=None, active=0, paused=0, stall=0, pause_since=None, waiting=0, blending=0, wraps=0, ready_at=None)
        original_ready = pet.frame_store.ready

        def ready(*values, **kwargs):
            elapsed = time.monotonic()-start
            if args.inject_stalls and .32 <= elapsed % .8 < .44:
                return None
            return original_ready(*values, **kwargs)

        pet.frame_store.ready = ready
        timer = QTimer()
        timer.setTimerType(Qt.TimerType.PreciseTimer)
        timer.setInterval(16)

        def tick():
            now = time.monotonic()
            if now-start >= args.seconds:
                timer.stop()
                app.quit()
                return
            if state['last'] is not None:
                gaps.append((now-state['last'])*1000)
            state['last'] = now
            active = behavior.release_spring is spring and not spring.settled
            before = spring.elapsed
            t = time.perf_counter()
            pet.animate()
            callbacks.append((time.perf_counter()-t)*1000)
            if pet.presentation is release_clock:
                if release_clock.stalled:state['stall']+=1
                if release_clock.waiting:state['waiting']+=1
                elif state['ready_at'] is None:state['ready_at']=now-start
                if release_clock.blending:state['blending']+=1
                if release_clock.looped:state['wraps']+=1
            if active:
                state['active'] += 1
                if spring.elapsed <= before:
                    state['paused'] += 1
                    if state['pause_since'] is None:
                        state['pause_since'] = now
                elif state['pause_since'] is not None:
                    pauses.append((now-state['pause_since'])*1000)
                    state['pause_since'] = None

        timer.timeout.connect(tick)
        timer.start()
        try:
            app.exec()
            if state['pause_since'] is not None:
                pauses.append((time.monotonic()-state['pause_since'])*1000)
            def p95(values):
                return sorted(values)[int((len(values)-1)*.95)] if values else 0.
            report = dict(selectedAnimation=selected['id'],releaseCache=bool(selected.get('releaseSource')),
                          warmDrag=args.warm_drag,sizePercent=args.size_percent,holdSpring=args.hold_spring,
                          waitingTicks=state['waiting'],blendTicks=state['blending'],loopWraps=state['wraps'],
                          firstFrameReadyMs=round(state['ready_at']*1000,3) if state['ready_at'] is not None else None,
                          scope='真实WebP、Qt offscreen；非Cocoa桌面/显示合成验收',
                          injectedReadyStalls=args.inject_stalls,
                          seconds=round(time.monotonic()-start, 3), activeTicks=state['active'],
                          physicsPauseTicks=state['paused'], longestPhysicsPauseMs=round(max(pauses, default=0), 3),
                          spriteStalledTicks=state['stall'], physicsSeconds=round(spring.elapsed, 3),
                          guiCallbackP95Ms=round(p95(callbacks), 3), timerGapP95Ms=round(p95(gaps), 3),
                          guiCallbackMedianMs=round(statistics.median(callbacks), 3),
                          finalPosition=[pet.x(), pet.y()], floorY=area.bottom()+1-pet.height(), settled=spring.settled,
                          frameStoreStats=dict(pet.frame_store.stats))
        finally:
            pet.frame_store.ready = original_ready
            pet.close()
            app.processEvents()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
