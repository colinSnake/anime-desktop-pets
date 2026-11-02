#!/usr/bin/env python3
"""对比 GUI 取帧耗时、事件间隔和进程 RSS；不显示窗口、不连接任何账号。"""
import argparse
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--mode',choices=['baseline','enhanced'],required=True)
parser.add_argument('--seconds',type=float,default=16)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
with tempfile.TemporaryDirectory(prefix='dragon-bench-') as home:
    os.environ.update(HOME=home,BAILONG_DATA_DIR=home,QT_QPA_PLATFORM='offscreen',BAILONG_CODEX='/usr/bin/false')
    sys.path[:0]=[str(ROOT/'apps/pet-runtime/bailong'),str(ROOT/'.local/pet-build/generated-source/app')]
    import psutil
    from PySide6.QtCore import QTimer,Qt
    from PySide6.QtWidgets import QApplication
    from dragon_frames import webp_frame_count
    if args.mode=='baseline':
        from animation_frames import AnimationFrameStore
    else:
        from dragon_frames import AnimationFrameStore
    app=QApplication([])
    store=AnimationFrameStore()
    assets=ROOT/'.local/pet-build/source/outputs/白龙桌宠素材'
    manifest=json.loads((assets/'素材清单.json').read_text())
    items=[manifest['idle'],manifest['variants'][0],manifest['additionalIdleAnimations'][0],manifest['variants'][1]]
    paths=[assets/(x.get('playbackFile') or x['file'].replace('.webm','.webp')) for x in items]
    counts=[webp_frame_count(p) for p in paths]
    process=psutil.Process()
    initial_rss=process.memory_info().rss
    cpu=process.cpu_times()
    state=dict(start=time.perf_counter(),last=None,action=-1,first_ready=None,
               presented=None,frames=0,misses=0,peak_rss=initial_rss)
    samples=[];gaps=[];cold=[]
    def tick():
        now=time.perf_counter();elapsed=now-state['start']
        if elapsed>=args.seconds:
            timer.stop();app.quit();return
        if state['last'] is not None:gaps.append((now-state['last'])*1000)
        state['last']=now
        group=min(3,int(elapsed//4));path=paths[group];count=counts[group]
        local=elapsed%4
        index=min(count-1,int(local/4*count))
        if group!=state['action']:
            state.update(action=group,first_ready=None,switch=now,presented=None)
            if args.mode=='enhanced':store.activate(path,512,count)
        start=time.perf_counter()
        if args.mode=='baseline':
            result=store.frame(path,512,index)
        else:
            store.request(path,512,index,count);result=store.ready(path,512,index)
        samples.append((time.perf_counter()-start)*1000)
        if result is None:state['misses']+=1
        else:
            if state['first_ready'] is None:
                state['first_ready']=time.perf_counter();cold.append((state['first_ready']-state['switch'])*1000)
            if state['presented']!=(group,index):state['frames']+=1
            state['presented']=(group,index)
        state['peak_rss']=max(state['peak_rss'],process.memory_info().rss)
    timer=QTimer();timer.setTimerType(Qt.TimerType.PreciseTimer);timer.setInterval(16);timer.timeout.connect(tick);timer.start()
    app.exec()
    elapsed=time.perf_counter()-state['start'];end_cpu=process.cpu_times()
    def percentile(data,p):
        return sorted(data)[min(len(data)-1,int((len(data)-1)*p))] if data else 0
    report=dict(mode=args.mode,scope='512px 真实 WebP；Qt offscreen 取帧，非真实桌面/GPU 验收',
                seconds=round(elapsed,3),ticks=len(samples),presentedDistinctFrames=state['frames'],
                unavailableTicks=state['misses'],
                guiFrameMs=dict(median=statistics.median(samples),p95=percentile(samples,.95),p99=percentile(samples,.99),max=max(samples)),
                timerGapMs=dict(p95=percentile(gaps,.95),p99=percentile(gaps,.99),max=max(gaps)),
                firstAvailableMs=cold,initialRSSMiB=initial_rss/1024**2,
                peakRSSMiB=state['peak_rss']/1024**2,
                cpuSeconds=(end_cpu.user+end_cpu.system)-(cpu.user+cpu.system),
                pixelBudgetMiB=store.max_bytes/1024**2,
                pixmapBudgetMiB=getattr(store,'pixmap_budget',0)/1024**2,
                cachedMiB=store.cached_bytes/1024**2,
                stats=getattr(store,'stats',{}))
    store.close()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
