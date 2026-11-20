#!/usr/bin/env python3
"""离线检查当前项目的入口、平台边界、品牌和素材；不启动桌面。"""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProjectChecks(unittest.TestCase):
    def test_retired_macos_host_has_no_entrypoints(self):
        retired = ('apps/companion-macos/Package.swift', 'scripts/build.sh', 'scripts/petctl.sh',
                   'scripts/install.sh', 'scripts/uninstall.sh', 'scripts/publish-app-bundle.py',
                   'scripts/preview-character.sh', 'scripts/preview-full-pet.sh',
                   'config/companion.example.json', 'resources/branding/AppIcon.icns',
                   'apps/runtime-bridge/player_worker.py', 'apps/app-service/src/player-runtime.ts',
                   'scripts/check-qt-runtime.mjs')
        for relative in retired:
            with self.subTest(relative=relative):
                self.assertFalse((ROOT / relative).exists())

    def test_current_application_boundaries(self):
        for relative in ('apps/desktop/src/main.ts', 'apps/app-service/src/server.ts',
                         'apps/workspace-ui/src/App.tsx', 'packages/contracts/src/index.ts',
                         'apps/desktop/src/video-preview/video-window.ts', 'apps/runtime-bridge/task_events.py',
                         'apps/speech-runtime/stdio_service.py'):
            with self.subTest(relative=relative):
                self.assertTrue((ROOT / relative).is_file())

    def test_platform_sources_have_no_hardcoded_user_paths(self):
        sources = sorted(path for app in ('desktop', 'app-service')
                         for path in (ROOT / 'apps' / app / 'native').glob('*.swift'))
        self.assertTrue(sources, '未找到 Electron 使用的 macOS 平台助手')
        for file in sources:
            self.assertNotRegex(file.read_text(), r'/(Users|home)/[^/"\s]+/', str(file))

    def test_local_media_hashes(self):
        manifest = ROOT / 'resources/assets.local.json'
        if not manifest.exists():
            self.skipTest('未导入私有本机素材')
        for asset in json.loads(manifest.read_text())['assets']:
            path = ROOT / 'resources' / asset['file']
            self.assertEqual(path.stat().st_size, asset['bytes'])
            with path.open('rb') as stream:
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            self.assertEqual(digest.hexdigest(), asset['sha256'])

    def test_shell_syntax(self):
        for script in (ROOT / 'scripts').glob('*.sh'):
            subprocess.run(['/bin/bash', '-n', str(script)], check=True)

    def test_license_scope_is_explicit(self):
        self.assertTrue((ROOT / 'LICENSE').exists())
        self.assertIn('media', (ROOT / 'THIRD_PARTY_NOTICES.md').read_text().lower())


if __name__ == '__main__':
    unittest.main(verbosity=2)
