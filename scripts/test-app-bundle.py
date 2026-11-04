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

    def test_cleanup_checks_ownership_and_keeps_current_and_symlink_apps(self):
        owned = bundle(self.build / '桌边小崽.previous.20261104-120000-1.app')
        bundle(self.build / '桌边小崽.previous.20261104-120000-2.app', identity='other')
        bundle(self.build / publisher.APP_NAME)
        unrecognized = bundle(self.build / 'Unrecognized.previous.20261104-120000-3.app')
        (self.build / '桌边小崽.previous.20261104-120000-4.app').symlink_to(owned)
        with patch.object(cleaner, 'HOST_HISTORY', self.build):
            self.assertEqual(set(cleaner.candidates(helper=False)), {owned})
        self.assertTrue(unrecognized.exists())

    def test_cleanup_without_candidates_does_not_scan_processes(self):
        with patch.object(cleaner.subprocess, 'run') as run:
            self.assertEqual(cleaner.busy_paths([]), set()); run.assert_not_called()


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
        data = self.home / 'Library/Application Support/DragonCodexCompanion/keep.txt'
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
