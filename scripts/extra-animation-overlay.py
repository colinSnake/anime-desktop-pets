"""构建时合并本地已审核动作；固定上游素材只读。"""
import hashlib
import json
from pathlib import Path
import shutil

IDS = {'idle03', 'idle04', 'idle05', 'idle06', 'move01left', 'move01right',
       'move02', 'move02left', 'move03left', 'move03right'}
ARCHIVE_SHA = '4b636bf1e92a82a798b01be09cbd658cbfc46c548dd1a38acee31368b9c78580'


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def apply(stock, target, extra):
    manifest = json.loads((extra / 'extension-manifest.json').read_text())
    audit = json.loads((extra / 'conversion-audit.json').read_text())
    items = manifest['additionalIdleAnimations'] + manifest['movementAnimations']
    records = {item['id']: item for item in audit['actions']}
    if (manifest['source']['archiveSha256'] != ARCHIVE_SHA or
            audit['source']['archiveSha256'] != ARCHIVE_SHA or
            len(items) != 10 or {item['id'] for item in items} != IDS or set(records) != IDS):
        raise ValueError('扩展动作来源或数量不符；先执行 prepare-extra-animations.py')
    for item in items:
        record = records[item['id']]
        relative = Path(item['playbackFile'])
        path = (extra / relative).resolve()
        if (relative.is_absolute() or '..' in relative.parts or
                not path.is_relative_to(extra.resolve()) or path.suffix != '.webp' or
                digest(path) != record['webpSha256'] or
                item['durationMs'] != record['durationMs'] or
                not record['losslessVisiblePixelsAndTimingVerified']):
            raise ValueError('扩展素材校验失败：' + item['id'])
        if item['id'].startswith('move'):
            start, stop = item['moveStartMs'], item['moveStopMs']
            if not 0 <= start < stop <= item['durationMs'] or item['sourceFacing'] not in ('left', 'right'):
                raise ValueError('移动时段或朝向无效')
    shutil.copytree(stock, target)
    assets = target / '白龙桌宠素材'
    base = json.loads((assets / '素材清单.json').read_text())
    for item in base.get('additionalIdleAnimations', []):
        if item.get('id') == 'idle2':
            item['name'] = '待机动作02'
    for group in ('additionalIdleAnimations', 'movementAnimations'):
        additions = []
        for item in manifest[group]:
            relative = 'dragon-extra/' + item['id'] + '.webp'
            dest = assets / relative
            dest.parent.mkdir(exist_ok=True)
            shutil.copy2(extra / item['playbackFile'], dest)
            additions.append(dict(item, file=relative, playbackFile=relative))
        base[group] = base.get(group, []) + additions
    (assets / '素材清单.json').write_text(json.dumps(base, ensure_ascii=False, indent=2) + '\n')
    provenance = dict(source=manifest['source'], auditSha256=digest(extra / 'conversion-audit.json'),
                      assets={identifier: records[identifier]['webpSha256'] for identifier in sorted(IDS)})
    (target / 'DRAGON_EXTRA_SOURCE.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n')
    if (extra / 'source-notices').exists():
        shutil.copytree(extra / 'source-notices', target / 'dragon-extra-notices')
    return provenance
