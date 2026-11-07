#!/usr/bin/env python3
"""Offline project checks. Does not launch Codex, register services or make API calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ProjectChecks(unittest.TestCase):
    def test_startup_cover_keeps_painting_and_avoids_letterboxing(self):
        host = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        player = (host/'BootPlayer.swift').read_text()
        coordinator = (host/'Coordinator.swift').read_text()
        self.assertIn('preservesTargetActivation ? .resizeAspectFill : .resizeAspect', player)
        self.assertNotIn('hold-final-frame', player, 'normal launch should hand off when the startup video ends')
        self.assertNotIn('player.pause()', player, 'startup playback must not wait for the Codex window readiness signal')
        self.assertIn('let opacity = preservesTargetActivation ? 1 : config.opacity(at: t)', player)
        self.assertEqual(player.count('StartupPresentation.opacity('), 2, 'initial display and every fade tick must cap opacity')
        self.assertNotIn('followsTargetWindow', player, 'keep following actual frame changes until handoff')
        self.assertIn('options.arguments = runtime.startupLaunchArguments(at: url)', coordinator)
        self.assertIn('StartupWindowSizing.request(', coordinator)
        self.assertIn('content-readiness=unknown', coordinator)
        sizing = (host/'StartupWindowSizing.swift').read_text()
        self.assertNotIn('AXIsProcessTrustedWithOptions', sizing, 'never auto-prompt for Accessibility')
        self.assertNotIn('kAXTitleAttribute', sizing, 'window sizing must not inspect UI text')

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
                     runtime/'pets/pet_library.py', ROOT/'integrations/bailong/upstream-files.json'):
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
        self.assertNotIn('LSUIElement', script, 'the host must appear as a regular Dock application')

    def test_friendly_copy_keeps_persistent_identity(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        copy = (source/'AppCopy.swift').read_text()
        self.assertIn('static let name = "桌边小崽"', copy)
        self.assertIn('让喜欢的角色，陪在桌边。', copy)
        self.assertNotIn('伴侣', copy)
        coordinator = (source/'Coordinator.swift').read_text()
        for key in ('AppCopy.name', 'AppCopy.tagline', 'AppCopy.runningMessage', 'AppCopy.quitTitle'):
            self.assertIn(key, coordinator)
        for path in source.glob('*.swift'):
            self.assertNotIn('伴侣', path.read_text())
        self.assertIn('AnimeDesktopPets', (source/'Runtime.swift').read_text())
        self.assertIn('DragonCodexCompanion', (source/'Runtime.swift').read_text())
        build = (ROOT/'scripts/build.sh').read_text()
        self.assertIn("CFBundleIdentifier='local.dragon.codex-companion'", build)
        self.assertIn('build/桌边小崽.app', build)
        self.assertIn("CFBundleName='桌边小崽', CFBundleDisplayName='桌边小崽'", build)
        self.assertIn("CFBundleShortVersionString='0.7.11', CFBundleVersion='31'", build)
        self.assertIn('scripts/publish-app-bundle.py', build)

    def test_external_catalog_validation_never_blocks_appkit_main_actor(self):
        controller = (ROOT/'apps/companion-macos/Sources/DragonCompanion/PetController.swift').read_text()
        self.assertIn('Task.detached(priority: .utility)', controller)
        self.assertIn('descriptorLoadTask == nil', controller)
        self.assertIn('guard self.desiredVisible else { return }', controller)
        self.assertIn('private func launchExternal(_ descriptor: ExternalPetDescriptor)', controller)

    def test_pet_menu_uses_truthful_lifecycle_actions(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        coordinator = (source/'Coordinator.swift').read_text()
        pet_controller = (source/'PetController.swift').read_text()
        runtime = (source/'PetInstanceRuntime.swift').read_text()
        controller = (source/'PetController.swift').read_text()
        self.assertIn('togglePetAvailability', coordinator)
        self.assertIn('"停止全部桌宠"', coordinator)
        self.assertIn('"启动全部桌宠"', coordinator)
        self.assertIn('"停止实例"', coordinator)
        self.assertIn('"启动实例"', coordinator)
        self.assertIn('运行异常：', coordinator)
        self.assertIn('func startEnabledInstances()', runtime)
        self.assertIn('func stopAllInstances()', runtime)
        self.assertIn('WindowGeometry.hasVisibleWindow(pid: $0.processIdentifier)', controller)
        self.assertNotIn('expectedSize: $0.bundleIdentifier', controller)
        self.assertNotIn('"全部显示"', coordinator)
        self.assertNotIn('"隐藏 \\(title)"', coordinator)
        self.assertNotIn('"结束本次桌宠"', pet_controller)
        self.assertIn('"允许关联窗口大小"', coordinator)
        self.assertNotIn('允许同步 Codex 窗口尺寸', coordinator)

    def test_data_folder_menu_matches_opened_directory(self):
        coordinator = (ROOT/'apps/companion-macos/Sources/DragonCompanion/Coordinator.swift').read_text()
        self.assertIn('NSMenuItem(title: "打开数据文件夹", action: #selector(openSettings)', coordinator)
        self.assertIn('private func openSettings() { NSWorkspace.shared.open(runtime.state) }', coordinator)
        self.assertNotIn('打开配置文件夹', coordinator)

    def test_pet_manager_is_nested_and_uses_existing_helper(self):
        host = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        coordinator = (host/'Coordinator.swift').read_text()
        rebuild = coordinator.split('private func rebuildMenu()', 1)[1].split('func menuNeedsUpdate', 1)[0]
        management = coordinator.split('private func petManagementMenu()', 1)[1].split('@objc private func showPet', 1)[0]
        self.assertNotIn('NSMenuItem(title: "桌宠管理…"', rebuild)
        self.assertIn('NSMenuItem(title: "桌宠管理…"', management)
        self.assertIn('self.addLocalPets(packages, completion: completion)', coordinator)
        window = (host/'PetManagerWindow.swift').read_text()
        self.assertIn('table.allowsMultipleSelection = true', window)
        self.assertIn('一次最多添加16只', window)
        builder = (ROOT/'scripts/build-pet-runtime.py').read_text()
        self.assertIn("'pet_sources.py'", builder)
        self.assertIn("from pet_sources import main as sources_main", builder)
        self.assertIn("'pet_sources'", builder)
        fingerprints = (ROOT/'scripts/pet-build-inputs.py').read_text()
        self.assertIn("'pet_sources.py'", fingerprints)
        tests = (ROOT/'scripts/test.sh').read_text()
        self.assertIn('scripts/test-pet-sources.py', tests)

    def test_old_app_name_is_removed_from_text_references(self):
        old_name = '桌边' + '小伙伴'
        for directory, folders, names in os.walk(ROOT):
            folders[:] = [name for name in folders if name not in {'.git', '.build', '.local', 'build'}]
            for name in names:
                path = Path(directory) / name
                if path.suffix in {'.md', '.swift', '.py', '.sh'}:
                    self.assertNotIn(old_name, path.read_text(errors='replace'), str(path))

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
