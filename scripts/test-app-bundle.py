#!/usr/bin/env python3
"""App publication and lifecycle regressions with isolated HOME fixtures."""
import importlib.util
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publisher = load('publish-app-bundle')
cleaner = load('clean-builds')


def bundle(path, identity=publisher.BUNDLE_ID, marker='old'):
    (path / 'Contents/MacOS').mkdir(parents=True)
    with (path / 'Contents/Info.plist').open('wb') as stream:
        plistlib.dump(dict(CFBundleIdentifier=identity, CFBundleName='桌边小崽',
                           CFBundleDisplayName='桌边小崽', CFBundleExecutable='DragonCompanion'), stream)
    exe = path / 'Contents/MacOS/DragonCompanion'
    exe.write_text('#!/bin/sh\nexit 0\n'); exe.chmod(0o755)
    (path / 'marker').write_text(marker)
    return path


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desk-cub-bundle-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.build = self.root / 'build'; self.build.mkdir()
        self.staged = bundle(self.root / 'stage' / publisher.APP_NAME, marker='new')

    def test_first_publish_uses_chinese_bundle_name(self):
        target, archives = publisher.publish(self.staged, self.build)
        self.assertEqual(target.name, '桌边小崽.app')
        self.assertEqual((target / 'marker').read_text(), 'new')
        self.assertEqual(archives, [])

    def test_publish_archives_only_current_bundle_name(self):
        bundle(self.build / publisher.APP_NAME)
        unrelated_name = bundle(self.build / 'Unrecognized.app')
        target, archives = publisher.publish(self.staged, self.build)
        self.assertEqual(len(archives), 1)
        self.assertTrue(unrelated_name.exists())
        self.assertEqual((target / 'marker').read_text(), 'new')
        self.assertTrue(all(cleaner.HOST_PATTERN.fullmatch(p.name) for p in archives))

    def test_unrecognized_bundle_name_is_not_touched(self):
        current = bundle(self.build / publisher.APP_NAME)
        unrelated = bundle(self.build / 'Unrecognized.app', identity='unrelated')
        target, archives = publisher.publish(self.staged, self.build)
        self.assertEqual((target / 'marker').read_text(), 'new')
        self.assertEqual(len(archives), 1)
        self.assertTrue(unrelated.exists())
        self.assertTrue(current.exists())
        self.assertFalse(self.staged.exists())
        archives = list(self.build.glob('桌边小崽.previous.*.app'))
        self.assertEqual(len(archives), 1)
        self.assertEqual((archives[0] / 'marker').read_text(), 'old')

    def test_symlink_and_dangling_symlink_refused(self):
        link = self.build / publisher.APP_NAME
        for destination in [self.staged, self.root / 'missing']:
            link.symlink_to(destination)
            with self.assertRaises(ValueError): publisher.publish(self.staged, self.build)
            self.assertTrue(link.is_symlink()); link.unlink()

    def test_failed_publish_restores_prior_app(self):
        bundle(self.build / publisher.APP_NAME)
        rename = os.rename
        def fail(source, target):
            if source == self.staged: raise OSError('synthetic publication failure')
            return rename(source, target)
        with patch.object(publisher.os, 'rename', side_effect=fail):
            with self.assertRaises(OSError): publisher.publish(self.staged, self.build)
        self.assertEqual((self.build / publisher.APP_NAME / 'marker').read_text(), 'old')
        self.assertTrue(self.staged.exists())
        self.assertFalse(list(self.build.glob('*.previous.*')))

    def test_cannot_publish_current_bundle_onto_itself(self):
        target, _ = publisher.publish(self.staged, self.build)
        with self.assertRaises(ValueError): publisher.publish(target, self.build)
        self.assertTrue(target.exists())

    def test_build_keeps_runtime_assets_external_and_explicit(self):
        build_script = (ROOT / 'scripts/build.sh').read_text()
        pet_controller = (ROOT / 'apps/companion-macos/Sources/DragonCompanion/PetController.swift').read_text()
        self.assertIn("config['externalPetAssetsPath'] = str(Path(sys.argv[3]).expanduser().resolve())", build_script)
        self.assertIn('BAILONG_ASSETS_DIR', pet_controller)

    def test_host_has_dock_identity_and_branded_status_item(self):
        build_script = (ROOT / 'scripts/build.sh').read_text()
        main = (ROOT / 'apps/companion-macos/Sources/DragonCompanion/Main.swift').read_text()
        coordinator = (ROOT / 'apps/companion-macos/Sources/DragonCompanion/Coordinator.swift').read_text()
        self.assertNotIn('LSUIElement', build_script)
        self.assertIn('mode == .controlTest ? .prohibited : .regular', main)
        self.assertIn('let icon = makeStatusItemImage()', coordinator)
        self.assertIn('NSImage(size: NSSize(width: 18, height: 18))', coordinator)
        self.assertIn('image.isTemplate = true', coordinator)
        self.assertNotIn('forResource: "AppIcon", withExtension: "icns"', coordinator)

    def test_cleanup_checks_ownership_and_keeps_current_and_symlink_apps(self):
        owned = bundle(self.build / '桌边小崽.previous.20261104-120000-1.app')
        bundle(self.build / '桌边小崽.previous.20261104-120000-2.app', identity='other')
        bundle(self.build / publisher.APP_NAME)
        unrecognized = bundle(self.build / 'Unrecognized.previous.20261104-120000-3.app')
        (self.build / '桌边小崽.previous.20261104-120000-4.app').symlink_to(owned)
        with patch.object(cleaner, 'ROOT', self.root), patch.object(cleaner, 'HOST_HISTORY', self.build):
            self.assertEqual(set(cleaner.candidates(helper=False)), {owned})
        self.assertTrue(unrecognized.exists())

    def test_cleanup_preserves_archives_when_current_host_is_missing(self):
        owned = bundle(self.build / '桌边小崽.previous.20261104-120000-1.app')
        with patch.object(cleaner, 'ROOT', self.root), patch.object(cleaner, 'HOST_HISTORY', self.build):
            self.assertEqual(cleaner.candidates(helper=False), [])
        self.assertTrue(owned.exists())

    def test_cleanup_without_candidates_does_not_scan_processes(self):
        with patch.object(cleaner.subprocess, 'run') as run:
            self.assertEqual(cleaner.busy_paths([]), set()); run.assert_not_called()


class CacheCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desk-cub-cache-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(cleaner, 'ROOT', self.root)
        self.root_patch.start(); self.addCleanup(self.root_patch.stop)

    def directory(self, relative):
        path = self.root / relative
        path.mkdir(parents=True)
        (path / 'marker').write_text('fixture')
        return path

    def test_only_explicit_cache_allowlist_is_selected(self):
        cache = self.directory('.build/out/ModuleCache.noindex')
        work = self.directory('.local/pet-build/work')
        stage = self.directory('.local/pet-build/generated-source')
        (stage / '.dragon-generated').write_text('generated local source\n')
        protected = [self.directory(p) for p in (
            '.build/out/Products', '.local/pet-build/source',
            '.local/pet-build/venv', '.local/pet-build/benchmark-20261105', '.local/reports',
            '.local/downloads', 'build')]
        self.assertEqual(set(cleaner.cache_candidates()), {cache, work, stage})
        self.assertTrue(all(p.exists() for p in protected))

    def test_generated_stage_requires_exact_ownership_marker(self):
        stage = self.directory('.local/pet-build/generated-source')
        marker = stage / '.dragon-generated'
        marker.write_text('user data\n')
        self.assertNotIn(stage, cleaner.cache_candidates())
        marker.write_text('generated local source\n')
        marker.unlink()
        marker.symlink_to(self.root / 'outside-marker')
        self.assertNotIn(stage, cleaner.cache_candidates())

    def test_symlink_cache_and_symlink_ancestor_are_not_selected(self):
        target = self.directory('outside')
        (self.root / '.build').symlink_to(target, target_is_directory=True)
        (target / 'out/ModuleCache.noindex').mkdir(parents=True)
        (self.root / '.local/pet-build').mkdir(parents=True)
        (self.root / '.local/pet-build/work').symlink_to(target, target_is_directory=True)
        self.assertEqual(cleaner.cache_candidates(), [])

    def test_duplicate_requires_verified_self_contained_helper(self):
        duplicate = self.directory('.local/pet-build/dist/BailongPet')
        app = bundle(self.root / '.local/pet-build/dist/BailongPet.app', identity='local.bailongpet.macos')
        with patch.object(cleaner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            self.assertTrue(cleaner.self_contained_helper(app))
            self.assertIn(duplicate, cleaner.cache_candidates())
        with patch.object(cleaner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
            self.assertNotIn(duplicate, cleaner.cache_candidates())
        outside = self.directory('external-files')
        (app / 'Contents/external').symlink_to(outside, target_is_directory=True)
        with patch.object(cleaner.subprocess, 'run') as run:
            self.assertFalse(cleaner.self_contained_helper(app)); run.assert_not_called()

    def test_helper_archives_require_a_valid_current_helper(self):
        history = self.root / '.local/pet-build/previous'
        old = bundle(history / '20261105-120000/BailongPet.app', identity='local.bailongpet.macos')
        with patch.object(cleaner, 'HELPER_HISTORY', history), \
             patch.object(cleaner, 'self_contained_helper', return_value=False):
            self.assertEqual(cleaner.candidates(host=False), [])
        with patch.object(cleaner, 'HELPER_HISTORY', history), \
             patch.object(cleaner, 'self_contained_helper', return_value=True):
            self.assertEqual(cleaner.candidates(host=False), [old.parent])

    def test_active_build_processes_are_detected(self):
        result = subprocess.CompletedProcess([], 0, stdout=(
            '123 /usr/bin/swift-frontend\n124 /usr/bin/python3\n'
            '125 python scripts/build-pet-runtime.py build\n'
            '126 /bin/zsh -c docs mention scripts/build.sh and PyInstaller\n'))
        with patch.object(cleaner.subprocess, 'run', return_value=result):
            self.assertEqual(cleaner.active_builds(), [
                '123 /usr/bin/swift-frontend',
                '125 python scripts/build-pet-runtime.py build'])

    def test_dry_run_and_busy_paths_preserve_data_then_clear_idle_cache(self):
        cache = self.directory('.build/out/ModuleCache.noindex')
        with patch.object(cleaner, 'active_builds', return_value=[]), \
             patch.object(cleaner, 'candidates', return_value=[]), \
             patch.object(cleaner, 'busy_paths', return_value=set()), \
             patch.object(cleaner, 'allocated_kib', return_value=4):
            cleaner.main(['--caches', '--dry-run'])
            self.assertTrue(cache.exists())
            with patch.object(cleaner, 'busy_paths', return_value={cache}):
                cleaner.main(['--caches'])
                self.assertTrue(cache.exists())
            cleaner.main(['--caches'])
            self.assertFalse(cache.exists())

    def test_active_build_or_failed_open_file_scan_deletes_nothing(self):
        cache = self.directory('.build/out/ModuleCache.noindex')
        with patch.object(cleaner, 'active_builds', return_value=['123 swift']):
            with self.assertRaises(SystemExit) as error:
                cleaner.main(['--caches'])
            self.assertEqual(error.exception.code, 1)
        with patch.object(cleaner, 'active_builds', return_value=[]), \
             patch.object(cleaner, 'candidates', return_value=[]), \
             patch.object(cleaner, 'busy_paths', side_effect=RuntimeError('fixture lsof failure')):
            with self.assertRaises(SystemExit) as error:
                cleaner.main(['--caches'])
            self.assertEqual(error.exception.code, 1)
        self.assertTrue(cache.exists())

    def test_symlink_swap_at_deletion_is_rejected(self):
        cache = self.directory('.build/out/ModuleCache.noindex')
        target = self.directory('keep')
        def replace_path(_):
            shutil.rmtree(cache); cache.symlink_to(target, target_is_directory=True)
            return 4
        with patch.object(cleaner, 'active_builds', return_value=[]), \
             patch.object(cleaner, 'candidates', return_value=[]), \
             patch.object(cleaner, 'busy_paths', return_value=set()), \
             patch.object(cleaner, 'allocated_kib', side_effect=replace_path):
            with self.assertRaises(SystemExit): cleaner.main(['--caches'])
        self.assertTrue((target / 'marker').exists())


class InstallFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desk-cub-install-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'fixture'; (self.root / 'scripts').mkdir(parents=True)
        for name in ['install.sh', 'uninstall.sh', 'publish-app-bundle.py']:
            shutil.copy2(ROOT / 'scripts' / name, self.root / 'scripts' / name)
        bundle(self.root / 'build' / publisher.APP_NAME, marker='new')
        self.home = Path(self.temp.name) / '用户 home'; self.home.mkdir()
        self.agent = self.home / 'Library/LaunchAgents/local.dragon.codex-companion.watch.plist'
        tools = Path(self.temp.name) / 'tools'; tools.mkdir()
        stubs = {
            'codesign': '#!/bin/sh\nexit 0\n',
            'ditto': '#!/usr/bin/env python3\nimport shutil,sys\nshutil.copytree(sys.argv[1],sys.argv[2])\n',
            'launchctl': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/tool-calls"\n[ "$1" != print ]\n',
        }
        for name, content in stubs.items():
            path = tools / name; path.write_text(content); path.chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home), PATH=str(tools) + ':' + os.environ['PATH'])

    def run_script(self, name, *args):
        return subprocess.run(['bash', str(self.root / 'scripts' / name), *args], env=self.env,
                              capture_output=True, text=True, timeout=10)

    def test_dry_run_has_no_side_effects_and_unknown_args_fail(self):
        for name in ['install.sh', 'uninstall.sh']:
            result = self.run_script(name, '--dry-run')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('桌边小崽.app', result.stdout)
            self.assertEqual(self.run_script(name, '--typo').returncode, 2)
        self.assertFalse((self.home / 'Applications').exists())
        self.assertFalse((self.home / 'tool-calls').exists())

    def test_install_rejects_unrecognized_agent_target(self):
        self.agent.parent.mkdir(parents=True)
        with self.agent.open('wb') as stream:
            plistlib.dump(dict(Label='local.dragon.codex-companion.watch', ProgramArguments=[
                str(self.home / 'Applications' / 'Unrecognized.app' / 'Contents/MacOS/DragonCompanion'), '--watch']), stream)
        result = self.run_script('install.sh', '--confirm')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ownership mismatch', result.stderr)
        self.assertFalse((self.home / 'Applications' / publisher.APP_NAME).exists())

    def test_install_publishes_current_name_and_agent_target(self):
        result = self.run_script('install.sh', '--confirm')
        self.assertEqual(result.returncode, 0, result.stderr)
        destination = self.home / 'Applications' / publisher.APP_NAME
        self.assertTrue((destination / 'Contents/Info.plist').is_file())
        with self.agent.open('rb') as stream: info = plistlib.load(stream)
        self.assertEqual(info['ProgramArguments'][0], str(destination / 'Contents/MacOS/DragonCompanion'))
        self.assertIn('bootstrap', (self.home / 'tool-calls').read_text())

    def test_install_refuses_same_label_with_unrelated_agent_executable(self):
        self.agent.parent.mkdir(parents=True)
        with self.agent.open('wb') as stream:
            plistlib.dump(dict(Label='local.dragon.codex-companion.watch', ProgramArguments=['/unrelated/tool']), stream)
        result = self.run_script('install.sh', '--confirm')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ownership mismatch', result.stderr)
        self.assertFalse((self.home / 'Applications' / publisher.APP_NAME).exists())

    def test_uninstall_removes_only_current_app_and_preserves_data(self):
        bundle(self.home / 'Applications' / publisher.APP_NAME)
        unrelated = bundle(self.home / 'Applications' / 'Unrecognized.app')
        data = self.home / 'Library/Application Support/AnimeDesktopPets/keep.txt'
        data.parent.mkdir(parents=True); data.write_text('keep')
        result = self.run_script('uninstall.sh', '--confirm')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(list((self.home / '.Trash').glob('*.app'))), 1)
        self.assertTrue(unrelated.exists())
        self.assertEqual(data.read_text(), 'keep')

    def test_uninstall_rejects_unrelated_current_app(self):
        current = bundle(self.home / 'Applications' / publisher.APP_NAME, identity='other')
        result = self.run_script('uninstall.sh', '--confirm')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(current.exists()); self.assertFalse((self.home / '.Trash').exists())
        self.assertFalse((self.home / 'tool-calls').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
