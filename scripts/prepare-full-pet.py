#!/usr/bin/env python3
"""获取、校验或离线自检完整白龙桌宠；不启动正常桌面模式、不修改 Codex。"""
import argparse
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.4.1-mac.3'
ARCHIVE_NAME = f'BailongPet-Mac-{VERSION}-arm64.zip'
URL = f'https://github.com/chihayaanon210-spec/bailong-desktop-pet-macos/releases/download/v{VERSION}/{ARCHIVE_NAME}'
SHA256 = 'c7df79f2b7e3fb90736e3ed8fb21be2fd6f8fe2d3982c494f0ee1c68004ccdb2'
SIZE = 734924315
LOCAL = ROOT / '.local'
DEST = LOCAL / 'pets' / f'bailong-{VERSION}'
APP = DEST / 'BailongPet.app'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_archive(archive):
    if archive.stat().st_size != SIZE or sha256(archive) != SHA256:
        raise ValueError('发布包大小或固定 SHA-256 不符，停止解压；不会修改签名或绕过系统安全设置。')
    with zipfile.ZipFile(archive) as source:
        total = 0
        for entry in source.infolist():
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename:
                raise ValueError(f'不安全的归档路径：{entry.filename}')
            total += entry.file_size
            if total > 4 * 1024 ** 3:
                raise ValueError('解压后大小超出预期上限')
            if stat.S_ISLNK(entry.external_attr >> 16):
                target = source.read(entry).decode('utf-8')
                if target.startswith('/'):
                    raise ValueError('归档包含绝对符号链接')
                parts = list(path.parent.parts)
                for part in PurePosixPath(target).parts:
                    if part == '..':
                        if not parts: raise ValueError('符号链接越过归档根目录')
                        parts.pop()
                    elif part != '.': parts.append(part)


def download(workers=12):
    """有界并发 Range 下载，每块验证长度，最终用固定发布哈希验证整个 ZIP。"""
    cache = LOCAL / 'downloads'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / ARCHIVE_NAME
    if archive.exists():
        validate_archive(archive)
        return archive
    chunks = cache / (ARCHIVE_NAME + '.chunks')
    chunks.mkdir(exist_ok=True)
    chunk_size = 2 * 1024 * 1024
    count = (SIZE + chunk_size - 1) // chunk_size
    # 只从 GitHub 官方发布地址获取重定向；不使用第三方镜像。
    request = urllib.request.Request(URL, method='HEAD', headers={'User-Agent':'DragonCompanion-local-integration'})
    with urllib.request.urlopen(request, timeout=30) as response:
        target = response.geturl()
    done = 0
    def fetch(index):
        begin = index * chunk_size
        end = min(SIZE, begin + chunk_size) - 1
        length = end - begin + 1
        path = chunks / f'{index:05d}'
        if path.exists() and path.stat().st_size == length:
            return
        for attempt in range(4):
            try:
                request = urllib.request.Request(target, headers={
                    'User-Agent':'DragonCompanion-local-integration', 'Range':f'bytes={begin}-{end}',
                    'Accept-Encoding':'identity'})
                with urllib.request.urlopen(request, timeout=45) as response:
                    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {begin}-{end}/{SIZE}':
                        raise ValueError('服务器未返回预期 Range；不回退为重复下载整个归档')
                    data = response.read(length + 1)
                if len(data) != length: raise ValueError('Range 内容被截断')
                temporary = path.with_suffix('.part')
                temporary.write_bytes(data)
                temporary.replace(path)
                return
            except Exception:
                if attempt == 3: raise
                time.sleep(1 + attempt)
    print(f'下载固定版本 {VERSION}（{SIZE / 1024**2:.1f} MiB），最多 {workers} 个连接；支持分块续传。',flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for future in concurrent.futures.as_completed([pool.submit(fetch, i) for i in range(count)]):
            future.result()
            done += 1
            if done % 10 == 0 or done == count:
                print(f'下载块：{done}/{count}',flush=True)
    temporary = archive.with_suffix('.zip.part')
    with temporary.open('wb') as out:
        for index in range(count):
            with (chunks / f'{index:05d}').open('rb') as stream:
                shutil.copyfileobj(stream, out)
    validate_archive(temporary)
    temporary.replace(archive)
    # 只清理本脚本专用的下载块，已验证的归档保留供追溯。
    shutil.rmtree(chunks)
    return archive


def inspect_app(app, verify_signature=True, assets_dir=None):
    app = app.expanduser().resolve(strict=True)
    if app.suffix != '.app': raise ValueError('需要完整的 .app 目录')
    with (app / 'Contents/Info.plist').open('rb') as stream: info = plistlib.load(stream)
    if info.get('CFBundleIdentifier') != 'local.bailongpet.macos': raise ValueError('不是预期的白龙 Mac 应用')
    build_version = info.get('CFBundleVersion')
    patch_version = None
    declared_patch = info.get('DragonPatchVersion')
    if isinstance(declared_patch, str) and declared_patch.startswith('dragon.'):
        metadata = json.loads((app / 'Contents/Resources/DRAGON_PATCH.json').read_text())
        if (metadata.get('patchVersion') != declared_patch or metadata.get('upstreamVersion') != VERSION or
                metadata.get('bundleVersion') != str(build_version)):
            raise ValueError('增强版补丁元数据不匹配')
        patch_version = declared_patch
    elif build_version != '3':
        raise ValueError('当前适配仅验证固定 mac.3 或带匹配来源标记的 Dragon 增强版')
    executable_name = info.get('CFBundleExecutable')
    if not isinstance(executable_name,str) or Path(executable_name).name != executable_name or executable_name in ('.','..'):
        raise ValueError('可执行文件名称无效')
    executable = (app / 'Contents/MacOS' / executable_name).resolve()
    if not executable.is_relative_to(app) or not executable.is_file() or not os.access(executable,os.X_OK):
        raise ValueError('应用缺少可执行文件或其路径越界')
    resources = app / 'Contents/Resources'
    asset_root = Path(assets_dir).expanduser().resolve() if assets_dir else resources / 'outputs/白龙桌宠素材'
    manifest = json.loads((asset_root / '素材清单.json').read_text())
    groups = {
        'movement': manifest.get('movementAnimations', []),
        'idle': [manifest['idle']] + manifest.get('additionalIdleAnimations', []),
        'interaction': manifest['variants'],
        'work': [item for item in manifest.get('workAnimations', []) if item],
        'special': [manifest[key] for key in ('dragAnimation','landingAnimation','quotaAnimation')],
    }
    counts = [len(groups[key]) for key in ('idle','interaction','work','special','movement')]
    if counts not in ([2,15,5,3,0], [6,15,5,3,6]):
        raise ValueError('动作清单不是完整原版25或增强35动作')
    for item in groups['movement']:
        if not 0 <= item.get('moveStartMs', -1) < item.get('moveStopMs', -1) <= item.get('durationMs', 0) or item.get('sourceFacing') not in ('left', 'right'):
            raise ValueError('移动动作时段或朝向无效')
    def validate_item(item):
        relative = item.get('playbackFile') or item['file'].replace('.webm','.webp')
        path = (asset_root / relative).resolve()
        if not path.is_relative_to(asset_root.resolve()) or not path.is_file():
            raise ValueError(f'动作播放文件缺失或越界：{relative}')
        if not isinstance(item.get('durationMs'),(int,float)) or not math.isfinite(item['durationMs']) or item['durationMs'] <= 0:
            raise ValueError('动作时长无效')
        transition = item.get('returnTransition')
        if transition: validate_item(transition)
    for group in groups.values():
        for item in group: validate_item(item)
    if verify_signature:
        subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True,capture_output=True)
    return {'app':str(app),'version':VERSION,'bundleIdentifier':info['CFBundleIdentifier'],
            'executable':str(executable),'patchVersion':patch_version,'actionCount':sum(map(len,groups.values())),
            'groups':{key:len(value) for key,value in groups.items()},
            'signature':'ad-hoc; verified' if verify_signature else 'not checked',
            'liveTaskStatus':'not connected'}


def prepare(workers):
    if APP.exists(): return inspect_app(APP)
    archive = download(workers)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pet-stage-',dir=DEST.parent) as stage:
        stage = Path(stage)
        subprocess.run(['/usr/bin/ditto','-x','-k',str(archive),str(stage)],check=True)
        app = stage / 'BailongPet.app'
        inspect_app(app)
        if DEST.exists(): raise ValueError('目标目录已存在，不自动覆盖')
        # 原样保留上游 App 与签名，不在其应用包内写配置或补丁。
        stage_content = stage / 'ready'
        stage_content.mkdir()
        shutil.move(str(app),str(stage_content/'BailongPet.app'))
        (stage_content/'source.json').write_text(json.dumps({
            'version':VERSION,'url':URL,'archiveSHA256':SHA256,'archiveBytes':SIZE,
            'scope':'local development only; no redistribution grant implied'},ensure_ascii=False,indent=2)+'\n')
        stage_content.rename(DEST)
    return inspect_app(APP)


def self_test(app, assets_dir=None):
    details = inspect_app(app, assets_dir=assets_dir)
    reports = LOCAL / 'reports' / time.strftime('full-pet-%Y%m%d-%H%M%S')
    reports.mkdir(parents=True,exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='dragon-pet-test-',dir='/tmp') as home:
        env = {'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':home,'TMPDIR':home,
               'LANG':'zh_CN.UTF-8','QT_QPA_PLATFORM':'offscreen',
               'BAILONG_DATA_DIR':str(reports),'BAILONG_CODEX':'/usr/bin/false'}
        if assets_dir:
            env['BAILONG_ASSETS_DIR'] = str(Path(assets_dir).expanduser().resolve())
        command = [details['executable'],'--self-test']
        sandbox = Path('/usr/bin/sandbox-exec')
        if not sandbox.exists(): raise ValueError('本机没有离线网络隔离工具，停止自动执行第三方自检')
        command = [str(sandbox),'-p','(version 1) (allow default) (deny network*)'] + command
        result = subprocess.run(command,env=env,capture_output=True,text=True,timeout=240)
    (reports/'stdout.log').write_text(result.stdout)
    (reports/'stderr.log').write_text(result.stderr)
    report_path = reports/'检查报告.json'
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    if result.returncode or report.get('passed') is not True:
        raise ValueError(f'完整桌宠离线自检失败，查看 {reports}')
    print(json.dumps({'report':str(report_path),**report},ensure_ascii=False,indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['fetch','check','self-test'])
    parser.add_argument('--app',type=Path,default=APP,help='check/self-test 可指定完整 App')
    parser.add_argument('--assets-dir',type=Path,help='验证素材位于包外的增强 helper')
    parser.add_argument('--workers',type=int,default=12)
    args = parser.parse_args()
    if not 1 <= args.workers <= 32: parser.error('workers 必须在 1–32 之间')
    try:
        if args.action == 'fetch': result = prepare(args.workers)
        elif args.action == 'check': result = inspect_app(args.app, assets_dir=args.assets_dir)
        else:
            self_test(args.app, assets_dir=args.assets_dir)
            return
        print(json.dumps(result,ensure_ascii=False,indent=2))
    except (OSError,ValueError,KeyError,subprocess.SubprocessError,zipfile.BadZipFile) as error:
        print(f'完整桌宠：{error}',file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__': main()
