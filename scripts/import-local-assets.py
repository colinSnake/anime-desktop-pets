#!/usr/bin/env python3
"""Import explicitly selected local media for private development, with hashes and provenance."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--pet-preview', type=Path, required=True)
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()
    entries = []
    for source, relative, suffixes in (
        (args.video, 'media/startup.mp4', {'.mp4'}),
        (args.pet_preview, 'pet/preview.png', {'.png'}),
    ):
        source = source.expanduser().resolve(strict=True)
        if not source.is_file() or source.suffix.lower() not in suffixes:
            parser.error(f'Invalid source: {source}')
        if source.stat().st_size > 256 * 1024 * 1024:
            parser.error(f'Unexpectedly large media: {source}')
        destination = ROOT / 'resources' / relative
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() != digest and not args.overwrite:
            parser.error(f'Refusing to overwrite changed media: {destination}; use --overwrite explicitly')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        entries.append(dict(file=relative, source=str(source), sha256=digest, bytes=destination.stat().st_size))
        print(f'Imported {relative} ({destination.stat().st_size:,} bytes)')
    (ROOT / 'resources/assets.local.json').write_text(json.dumps(dict(
        scope='local private development; not a redistribution license', assets=entries), ensure_ascii=False, indent=2) + '\n')

if __name__ == '__main__':
    main()
