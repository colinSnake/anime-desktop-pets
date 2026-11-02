#!/usr/bin/env python3
"""从已校验的上游动作生成小型 GIF；可选逐帧审计，不是原创出图或真实桌面录像。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prepare_full_pet',ROOT/'scripts/prepare-full-pet.py')
pet=importlib.util.module_from_spec(spec);spec.loader.exec_module(pet)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit-all-frames',action='store_true')
    args=parser.parse_args()
    try:
        from PIL import Image
    except ImportError:
        parser.error('此可选素材检查需要 Pillow；不影响完整桌宠正常运行')
    pet.inspect_app(pet.APP)
    assets=pet.APP/'Contents/Resources/outputs/白龙桌宠素材'
    manifest=json.loads((assets/'素材清单.json').read_text())
    items=[manifest['idle']]+manifest.get('additionalIdleAnimations',[])+manifest['variants']+[x for x in manifest['workAnimations'] if x]+[manifest[k] for k in ('dragAnimation','landingAnimation','quotaAnimation')]+manifest.get('movementAnimations',[])
    out=pet.LOCAL/'previews';out.mkdir(parents=True,exist_ok=True)
    selected={manifest['idle']['id']:'idle-preview.gif',manifest['variants'][0]['id']:'interaction-preview.gif'}
    reports=[]
    for item in items:
        relative=item.get('playbackFile') or item['file'].replace('.webm','.webp')
        with Image.open(assets/relative) as source:
            count=getattr(source,'n_frames',1)
            if count<=1:raise ValueError(f'并非多帧动画：{relative}')
            if not args.audit_all_frames and item['id'] not in selected:continue
            hashes=set();frames=[]
            step=max(1,round(count/(item['durationMs']/1000*12)))
            for index in range(count):
                source.seek(index)
                # load/convert 真正解码每一帧，不仅检查 n_frames 元数据。
                frame=source.convert('RGBA')
                hashes.add(hashlib.sha256(frame.tobytes()).digest())
                if item['id'] in selected and index%step==0:
                    resized=frame.resize((256,256),Image.Resampling.LANCZOS)
                    canvas=Image.new('RGBA',(256,256),'#181522')
                    canvas.alpha_composite(resized)
                    frames.append(canvas.convert('RGB'))
            if len(hashes)<2:raise ValueError(f'动作各帧像素完全相同：{relative}')
            if frames:
                frames[0].save(out/selected[item['id']],save_all=True,append_images=frames[1:],
                               duration=round(item['durationMs']/len(frames)),loop=0,disposal=2,optimize=False)
            reports.append({'id':item['id'],'file':relative,'decodedFrames':count,'distinctFrames':len(hashes)})
            print(f"已解码 {item['id']}: {count} 帧，{len(hashes)} 个不同画面",flush=True)
    report={'scope':'上游素材离线解码，不是桌面录像、原创海报或实时任务验收',
            'allActionsAudited':args.audit_all_frames,'actions':reports,
            'decodedFrameCount':sum(x['decodedFrames'] for x in reports)}
    (out/'animation-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(f'预览与报告：{out}')

if __name__=='__main__':
    try:main()
    except (OSError,ValueError,KeyError) as error:
        print(f'动画素材检查：{error}',file=sys.stderr);sys.exit(1)
