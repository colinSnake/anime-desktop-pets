#!/usr/bin/env python3
"""Regression checks for the shared helper and cache cleaner; never touch real builds."""
import importlib.util
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


cleaner = load('clean-builds')


def helper_bundle(path):
    contents = path / 'Contents'
    contents.mkdir(parents=True)
    (contents / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'local.bailongpet.macos'}))
    return path


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
        (stage / '.pet-generated').write_text('generated local source\n')
        protected = [self.directory(p) for p in (
            '.build/out/Products', '.local/pet-build/source',
            '.local/pet-build/venv', '.local/pet-build/benchmark-20261105', '.local/reports',
            '.local/downloads', 'build')]
        self.assertEqual(set(cleaner.cache_candidates()), {cache, work, stage})
        self.assertTrue(all(p.exists() for p in protected))

    def test_keep_prepared_skips_only_the_active_generated_stage(self):
        stage = self.directory('.local/pet-build/generated-source')
        (stage / '.pet-generated').write_text('generated local source\n')
        cache = self.directory('.build/out/ModuleCache.noindex')
        self.assertEqual(set(cleaner.cache_candidates(keep_prepared=True)), {cache})
        self.assertTrue(stage.exists())

    def test_old_input_validation_scratch_keeps_products_and_evidence(self):
        paths = ['.local/input-fix-validation/swift-build', '.local/input-fix-validation/minimal-swift-build']
        caches = {self.directory(path + '/out/Intermediates.noindex') for path in paths}
        products = [self.directory(path + '/out/Products') for path in paths]
        self.assertEqual(set(cleaner.cache_candidates(keep_prepared=True)), caches)
        self.assertTrue(all(path.exists() for path in products))

    def test_generated_stage_requires_exact_ownership_marker(self):
        stage = self.directory('.local/pet-build/generated-source')
        marker = stage / '.pet-generated'
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
        app = helper_bundle(self.root / '.local/pet-build/dist/BailongPet.app')
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
        old = helper_bundle(history / '20261105-120000/BailongPet.app')
        with patch.object(cleaner, 'HELPER_HISTORY', history), \
             patch.object(cleaner, 'self_contained_helper', return_value=False):
            self.assertEqual(cleaner.candidates(), [])
        with patch.object(cleaner, 'HELPER_HISTORY', history), \
             patch.object(cleaner, 'self_contained_helper', return_value=True):
            self.assertEqual(cleaner.candidates(), [old.parent])

    def test_active_build_processes_are_detected(self):
        result = subprocess.CompletedProcess([], 0, stdout=(
            '123 /usr/bin/swift-frontend\n124 /usr/bin/python3\n'
            '125 python scripts/build-pet-runtime.py build\n'
            '126 /bin/zsh -c docs mention Swift and PyInstaller\n'))
        with patch.object(cleaner.subprocess, 'run', return_value=result):
            self.assertEqual(cleaner.active_builds(), [
                '123 /usr/bin/swift-frontend',
                '125 python scripts/build-pet-runtime.py build'])

    def test_dry_run_and_busy_paths_preserve_data_then_clear_idle_cache(self):
        cache = self.directory('.build/out/ModuleCache.noindex')
        with patch.object(cleaner, 'active_builds', return_value=[]), \
             patch.object(cleaner, 'candidates', side_effect=list), \
             patch.object(cleaner, 'busy_paths', return_value=set()), \
             patch.object(cleaner, 'allocated_kib', return_value=4):
            cleaner.main(['--caches', '--dry-run'])
            self.assertTrue(cache.exists())
            with patch.object(cleaner, 'busy_paths', return_value={cache}):
                cleaner.main(['--caches'])
                self.assertTrue(cache.exists())
            cleaner.main(['--caches'])
            self.assertFalse(cache.exists())

    def test_cache_that_becomes_busy_during_cleanup_is_skipped(self):
        cache = self.directory('.build/out/ModuleCache.noindex')
        with patch.object(cleaner, 'active_builds', return_value=[]), \
             patch.object(cleaner, 'busy_paths', side_effect=[set(), {cache}]), \
             patch.object(cleaner, 'allocated_kib', return_value=128):
            cleaner.main(['--caches'])
        self.assertTrue(cache.exists())

    def test_cache_removed_by_another_cleaner_is_skipped(self):
        cache = self.directory('.build/out/ModuleCache.noindex')

        def remove_after_measurement(_):
            shutil.rmtree(cache)
            return 128

        with patch.object(cleaner, 'active_builds', return_value=[]), \
             patch.object(cleaner, 'busy_paths', return_value=set()), \
             patch.object(cleaner, 'allocated_kib', side_effect=remove_after_measurement):
            cleaner.main(['--caches'])
        self.assertFalse(cache.exists())

    def test_active_build_or_failed_open_file_scan_deletes_nothing(self):
        cache = self.directory('.build/out/ModuleCache.noindex')
        with patch.object(cleaner, 'active_builds', return_value=['123 swift']):
            with self.assertRaises(SystemExit) as error:
                cleaner.main(['--caches'])
            self.assertEqual(error.exception.code, 1)
        with patch.object(cleaner, 'active_builds', return_value=[]), \
             patch.object(cleaner, 'candidates', side_effect=list), \
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
             patch.object(cleaner, 'candidates', side_effect=list), \
             patch.object(cleaner, 'busy_paths', return_value=set()), \
             patch.object(cleaner, 'allocated_kib', side_effect=replace_path):
            with self.assertRaises(SystemExit): cleaner.main(['--caches'])
        self.assertTrue((target / 'marker').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
