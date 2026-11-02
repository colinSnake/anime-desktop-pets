#!/usr/bin/env python3
"""Offline project checks. Does not launch Codex, register services or make API calls."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ProjectChecks(unittest.TestCase):
    def test_config_safe_defaults(self):
        config = json.loads((ROOT/'config/companion.example.json').read_text())
        self.assertFalse(config['themeEnabled'])
        self.assertEqual(config['petBackend'], 'native')
        self.assertLess(config['holdAt'], config['transitionStart'])
        self.assertLess(config['transitionStart'], config['transitionEnd'])

    def test_provider_is_disabled_and_preserves_requested_model(self):
        config = json.loads((ROOT/'config/image-provider.example.json').read_text())
        self.assertFalse(config['enabled'])
        self.assertEqual(config['model'], 'gpt-image-2.5')
        self.assertEqual(config['baseUrl'], '')
        self.assertNotIn('apiKey', config)

    def test_monorepo_application_boundaries(self):
        host = ROOT / 'apps/companion-macos'
        runtime = ROOT / 'apps/pet-runtime'
        for path in (host/'Package.swift', host/'Sources/DragonCore',
                     host/'Sources/DragonCompanion', host/'Tests/DragonCoreTests',
                     runtime/'bailong/dragon_frames.py', runtime/'pets/dragon_pet_helper.py',
                     runtime/'pets/pet_library_ui.py', ROOT/'integrations/bailong/upstream-files.json'):
            self.assertTrue(path.exists(), str(path))
        for old in ('Package.swift', 'Sources', 'Tests', 'integrations/pets'):
            self.assertFalse((ROOT/old).exists(), '旧源码入口不得复活：' + old)
        self.assertFalse(list((ROOT/'integrations').rglob('*.py')), '业务 Python 源码应位于 apps/')

    def test_app_icon_is_required_by_packaging(self):
        branding = ROOT/'resources/branding'
        for name in ('app-icon.svg', 'app-icon.png', 'AppIcon.icns'):
            self.assertTrue((branding/name).is_file(), name)
        script = (ROOT/'scripts/build.sh').read_text()
        self.assertIn('CFBundleIconFile', script)
        self.assertIn('resources/branding/AppIcon.icns', script)

    def test_friendly_copy_keeps_persistent_identity(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        copy = (source/'AppCopy.swift').read_text()
        self.assertIn('static let name = "桌边小伙伴"', copy)
        self.assertIn('让喜欢的角色，陪在桌边。', copy)
        self.assertNotIn('伴侣', copy)
        coordinator = (source/'Coordinator.swift').read_text()
        for key in ('AppCopy.name', 'AppCopy.tagline', 'AppCopy.runningMessage', 'AppCopy.quitTitle'):
            self.assertIn(key, coordinator)
        for path in source.glob('*.swift'):
            self.assertNotIn('伴侣', path.read_text())
        self.assertIn('DragonCodexCompanion', (source/'Runtime.swift').read_text())
        build = (ROOT/'scripts/build.sh').read_text()
        self.assertIn("CFBundleIdentifier='local.dragon.codex-companion'", build)
        self.assertIn('build/Dragon Codex Companion.app', build)

    def test_sources_have_no_hardcoded_user_paths(self):
        sources = list((ROOT/'apps/companion-macos/Sources').rglob('*.swift'))
        self.assertTrue(sources, '未找到 Swift 源码，不能将空扫描计为通过')
        for file in sources:
            self.assertNotIn('/Users/ming/', file.read_text(), str(file))

    def test_local_media_hashes(self):
        manifest = ROOT/'resources/assets.local.json'
        if not manifest.exists(): self.skipTest('Import private media first')
        for asset in json.loads(manifest.read_text())['assets']:
            data = (ROOT/'resources'/asset['file']).read_bytes()
            self.assertEqual(len(data), asset['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), asset['sha256'])

    def test_shell_syntax(self):
        for script in (ROOT/'scripts').glob('*.sh'):
            subprocess.run(['/bin/bash','-n',str(script)],check=True)

    def test_license_scope_is_explicit(self):
        self.assertTrue((ROOT/'LICENSE').exists())
        self.assertIn('media', (ROOT/'THIRD_PARTY_NOTICES.md').read_text().lower())

    def test_poster_is_not_fake_generated(self):
        self.assertTrue((ROOT/'resources/poster/README.md').exists())
        brief = json.loads((ROOT/'theme/brief.json').read_text())
        self.assertEqual(brief['background']['source'], 'generated')
        self.assertEqual(brief['decorations']['density'], 'none')

if __name__ == '__main__': unittest.main(verbosity=2)
