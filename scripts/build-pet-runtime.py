#!/usr/bin/env python3
"""从校验过的上游源码生成私有增强版；不启动桌宠、不改动原始上游或 Codex。"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local/pet-build'
OVERLAY = ROOT / 'integrations/bailong'
RUNTIME_BAILONG = ROOT / 'apps/pet-runtime/bailong'
RUNTIME_PETS = ROOT / 'apps/pet-runtime/pets'
STOCK = ROOT / '.local/pets/bailong-0.4.1-mac.3/BailongPet.app'
SOURCE = ROOT.parent.parent / 'github/codex-pet/bailong-desktop-pet-macos'
STAGE = LOCAL / 'generated-source'
APP = LOCAL / 'dist/BailongPet.app'
PYTHON = LOCAL / 'venv/bin/python'
VERSION = 'dragon.38'
BUNDLE_VERSION = '32'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stage(source, bundle_assets=False):
    if not (STOCK / 'Contents/Resources/outputs').is_dir():
        raise ValueError('缺少原始完整素材，请先运行 prepare-full-pet.py fetch')
    extra_source = ROOT / '.local/animation-sources/jingh12312-v0.5.1-extra'
    if not all((extra_source / name).is_file()
               for name in ('extension-manifest.json', 'conversion-audit.json')):
        raise ValueError('缺少已审核的扩展动作源与转换记录，请先恢复 v0.5.1 源包并运行 prepare-extra-animations.py')
    expected = json.loads((OVERLAY / 'upstream-files.json').read_text())
    for name, checksum in expected.items():
        path = source / name
        if not path.is_file() or digest(path) != checksum:
            raise ValueError('上游源码与固定基线不符，停止打补丁：' + name)
    if STAGE.exists():
        # 仅删除脚本持有的私有生成目录，绝不删除源仓库。
        if not (STAGE / '.dragon-generated').is_file():
            raise ValueError('暂存目录不属于此脚本')
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    (STAGE / '.dragon-generated').write_text('generated local source\n')
    for folder in ('app', 'macos', 'licenses', 'upstream-notices'):
        shutil.copytree(source / folder, STAGE / folder,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for name in ('ASSETS.md', 'MACOS.txt', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', 'BUILD_INFO.json'):
        shutil.copy2(source / name, STAGE / name)
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location('extra_overlay', ROOT / 'scripts/extra-animation-overlay.py')
    overlay = module_from_spec(spec); spec.loader.exec_module(overlay)
    extra_source = overlay.apply(STOCK / 'Contents/Resources/outputs', STAGE / 'outputs', extra_source)
    # 松手派生缓存只新增独立目录，不改写35动作或原始素材。
    for assets in (STAGE / 'outputs/白龙桌宠素材', LOCAL / 'source/outputs/白龙桌宠素材'):
        if assets.is_dir():
            subprocess.run([str(PYTHON), str(ROOT / 'scripts/prepare-release-animations.py'),
                            '--assets-dir', str(assets)], check=True)
    for patch in sorted(OVERLAY.glob('*.patch')):
        subprocess.run(['/usr/bin/patch', '--batch', '--fuzz=0', '-p1', '-i', str(patch)], cwd=STAGE, check=True)
    for relative in ('macos/BailongPet.spec', 'app/selftest.py'):
        path = STAGE / relative
        text = path.read_text()
        text = text.replace('@DRAGON_PATCH_VERSION@', VERSION)
        text = text.replace('@DRAGON_BUNDLE_VERSION@', BUNDLE_VERSION)
        if '@DRAGON_' in text:
            raise ValueError(f'增强版版本占位符未解析：{relative}')
        path.write_text(text)
    pet_source = STAGE / 'app/pet.py'
    pet_text = pet_source.read_text()
    default_assets = "ASSETS=ROOT/'outputs/白龙桌宠素材'"
    if pet_text.count(default_assets) != 1:
        raise ValueError('无法定位增强桌宠素材根目录，停止生成')
    pet_source.write_text(pet_text.replace(
        default_assets,
        "ASSETS=Path(os.environ.get('BAILONG_ASSETS_DIR', ROOT/'outputs/白龙桌宠素材')).expanduser().resolve()", 1))
    for name in ('dragon_frames.py', 'dragon_ui.py', 'dragon_behavior.py', 'dragon_playback.py', 'dragon_tasks.py', 'dragon_quota.py'):
        shutil.copy2(RUNTIME_BAILONG / name, STAGE / 'app' / name)
    for name in ('dragon_instances.py', 'dragon_instance_ipc.py', 'dragon_pet_helper.py', 'pet_reference_lock.py', 'pet_library.py'):
        shutil.copy2(RUNTIME_PETS / name, STAGE / 'app' / name)
    pet_entry = STAGE / 'app/pet.py'
    pet_text = pet_entry.read_text()
    if '--multi-profile' not in pet_text:
        markers = ('    app=PetApplication(sys.argv)\n', '    app=QApplication(sys.argv)\n')
        marker = next((value for value in markers if value in pet_text), None)
        if marker is None:
            raise ValueError('增强桌宠入口缺少可注入的 QApplication 初始化点')
        dispatch = ("    if '--multi-profile' in sys.argv:\n"
                    "        from dragon_pet_helper import main as multi_main\n"
                    "        return multi_main()\n")
        pet_entry.write_text(pet_text.replace(marker, dispatch + marker, 1))
    spec = STAGE / 'macos/BailongPet.spec'
    spec_text = spec.read_text()
    spec_text = spec_text.replace(
        "'animation_frames', 'dragon_frames', 'dragon_ui', 'dragon_behavior', 'dragon_playback', 'desktop_visibility', 'quota'",
        "'animation_frames', 'dragon_frames', 'dragon_ui', 'dragon_behavior', 'dragon_playback', "
        "'dragon_instances', 'dragon_instance_ipc', 'dragon_pet_helper', 'pet_reference_lock', 'pet_library', 'desktop_visibility', 'quota'")
    spec_text = spec_text.replace(
        "datas = [(str(root/'outputs'), 'outputs'),",
        "datas = ([(str(root/'outputs'), 'outputs')] if __import__('os').environ.get('DRAGON_BUNDLE_PET_ASSETS') == '1' else []) + [")
    spec.write_text(spec_text)
    input_spec = spec_from_file_location('pet_build_inputs', ROOT / 'scripts/pet-build-inputs.py')
    inputs = module_from_spec(input_spec); input_spec.loader.exec_module(inputs)
    metadata = dict(schema=1, patchVersion=VERSION, bundleVersion=BUNDLE_VERSION,
                    buildInputs=inputs.fingerprints(),
                    upstreamVersion='0.4.1-mac.3',
                    upstreamCommit='8e5466d9a438deb6cb43f460e7f5a9bdb9d7a578',
                    upstreamArchiveSHA256='c7df79f2b7e3fb90736e3ed8fb21be2fd6f8fe2d3982c494f0ee1c68004ccdb2',
                    scope='private local adaptation; preserve all upstream notices',
                    assetsBundled=bundle_assets,
                    extraAnimations=extra_source,
                    releaseCache=json.loads((STAGE / 'outputs/白龙桌宠素材/dragon-release/catalog.json').read_text()),
                    assetOverlaySHA256=digest(ROOT / 'scripts/extra-animation-overlay.py'),
                    files={p.name: digest(p) for p in sorted(OVERLAY.iterdir()) if p.is_file()})
    (STAGE / 'DRAGON_PATCH.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    return metadata


def build(source, bundle_assets=False):
    metadata = stage(source, bundle_assets=bundle_assets)
    if not PYTHON.is_file():
        raise ValueError('缺少专用构建虚拟环境，参见 docs/桌宠增强与性能构建.md')
    env = os.environ.copy()
    env['PYINSTALLER_CONFIG_DIR'] = str(LOCAL / 'pyinstaller-cache')
    env['DRAGON_BUNDLE_PET_ASSETS'] = '1' if bundle_assets else '0'
    if APP.exists():
        archive = LOCAL / 'previous' / time.strftime('%Y%m%d-%H%M%S')
        archive.mkdir(parents=True, exist_ok=False)
        APP.rename(archive / APP.name)
    subprocess.run([str(PYTHON), '-m', 'PyInstaller', '--noconfirm', '--clean',
                    '--distpath', str(LOCAL / 'dist'), '--workpath', str(LOCAL / 'work'),
                    str(STAGE / 'macos/BailongPet.spec')], env=env, check=True)
    subprocess.run(['/usr/bin/chflags', '-R', 'nohidden', str(APP)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(APP)], check=True)
    subprocess.run([sys.executable, str(ROOT/'scripts/clean-builds.py'), '--helper-archives-only'], check=True)
    print(json.dumps({'app': str(APP), 'patch': metadata['patchVersion'], 'launched': False}, ensure_ascii=False))


def materialize_git_source(source, revision):
    """Export one immutable Git revision without touching its working tree."""
    source = source.resolve()
    try:
        root = Path(subprocess.check_output(
            ['git', '-C', str(source), 'rev-parse', '--show-toplevel'],
            text=True, stderr=subprocess.STDOUT).strip())
        subprocess.run(['git', '-C', str(source), 'cat-file', '-e', revision],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError('无法从指定源码目录导出 Git 提交：' + str(error)) from error
    if root != source:
        raise ValueError('--source 必须指向 Git 仓库根目录')
    archive = subprocess.run(['git', '-C', str(source), 'archive', '--format=tar', revision],
                             check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    temporary = tempfile.TemporaryDirectory(prefix='dragon-upstream-')
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as bundle:
            bundle.extractall(temporary.name)
    except Exception:
        temporary.cleanup()
        raise
    return temporary, Path(temporary.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['stage', 'build'])
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument('--source-revision',
                        help='从 --source Git 仓库导出指定提交后再构建；不修改工作树')
    parser.add_argument('--bundle-assets', action='store_true',
                        help='将动画素材内嵌到增强 helper；默认引用本地素材目录')
    args = parser.parse_args()
    temporary = None
    try:
        source = args.source.resolve()
        if args.source_revision:
            temporary, source = materialize_git_source(source, args.source_revision)
        if args.action == 'stage':
            metadata = stage(source, bundle_assets=args.bundle_assets)
            print(json.dumps({'source': str(STAGE), 'patch': metadata['patchVersion']}, ensure_ascii=False))
        else:
            build(source, bundle_assets=args.bundle_assets)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')
    finally:
        if temporary is not None:
            temporary.cleanup()

if __name__ == '__main__':
    main()
