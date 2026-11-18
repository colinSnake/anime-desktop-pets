"""Bounded first-frame thumbnail decoder. No Qt, runtime imports or disk writes."""
import io
import json
import os
from pathlib import Path
import stat
import sys
import warnings


def read_asset(root, relative, maximum):
    if (not isinstance(relative, str) or not relative or len(relative) > 512
            or '\\' in relative or ':' in relative or '\0' in relative
            or relative.startswith('/') or '..' in relative.split('/')):
        raise ValueError('invalid_asset')
    candidate = root / relative
    candidate.resolve(strict=True).relative_to(root)
    # Refuse symlink files and non-regular inputs, even when their target is inside.
    if candidate.is_symlink():
        raise ValueError('invalid_asset')
    fd = os.open(candidate, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
            raise ValueError('invalid_asset')
        data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError('invalid_asset')
        return data


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate_key')
        value[key] = item
    return value


def decode(data):
    from PIL import Image
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ('PNG', 'WEBP', 'JPEG') or image.width * image.height > 16_777_216:
                raise ValueError('invalid_image')
            image.seek(0)
            image.thumbnail((512, 512), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.convert('RGBA').save(output, format='PNG')
            result = output.getvalue()
            if len(result) > 1024 * 1024:
                raise ValueError('oversized_output')
            return result


def thumbnail(assets):
    try:
        if not isinstance(assets, str) or len(assets) > 1024 or not Path(assets).is_absolute():
            return None
        root = Path(assets).resolve(strict=True)
        if not root.is_dir():
            return None
        try:
            return decode(read_asset(root, 'workspace-cover.png', 4 * 1024 * 1024))
        except Exception:
            pass
        manifest = json.loads(read_asset(root, '素材清单.json', 1024 * 1024), object_pairs_hook=unique_object)
        idle = manifest.get('idle') if isinstance(manifest, dict) else None
        if not isinstance(idle, dict):
            return None
        return decode(read_asset(root, idle.get('playbackFile', idle.get('file')), 64 * 1024 * 1024))
    except Exception:
        return None


def main():
    try:
        data = sys.stdin.buffer.read(4097)
        if len(data) > 4096:
            return 2
        value = json.loads(data, object_pairs_hook=unique_object)
        if (not isinstance(value, dict) or set(value) != {'version', 'assets'}
                or type(value['version']) is not int or value['version'] != 1):
            return 2
        result = thumbnail(value['assets'])
        if result is None:
            return 2
        sys.stdout.buffer.write(result)
        return 0
    except Exception:
        return 2


if __name__ == '__main__':
    sys.exit(main())
