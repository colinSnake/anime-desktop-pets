#!/usr/bin/env python3
"""目录发现、多选添加与事务回归；仅临时目录和合成 WebP，禁止真实桌面。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['QT_STYLE_OVERRIDE'] = 'Fusion'
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/pets'))
from PIL import Image
from PySide6.QtWidgets import QApplication
import pet_sources as sources
import pet_library as library
from dragon_instances import InstanceController, InstanceError, InstanceStore, validate_registry
from dragon_instance_ipc import dispatch, validate_request

APP = QApplication.instance() or QApplication([])
APP.setStyle('Fusion')
APP.setQuitOnLastWindowClosed(False)


def fixture(root, identifier='local.test.cat', name='合成小猫'):
    root.mkdir(parents=True)
    (root / 'assets').mkdir()
    (root / 'notices').mkdir()
    image = root / 'assets/idle.webp'
    a, b = Image.new('RGBA', (4, 4), 'red'), Image.new('RGBA', (4, 4), 'blue')
    a.save(image, format='WEBP', save_all=True, append_images=[b], duration=[60, 80], lossless=True)
    a.close(); b.close()
    action = dict(id='idle', group='idle', file='assets/idle.webp', sizeBytes=image.stat().st_size,
                  sha256=library.digest(image), **library.probe_webp(image))
    value = dict(schemaVersion=1, id=identifier, version='1.0.0', name=name, runtime='webp-v1', defaultAction='idle',
        sources=[dict(repository='local/synthetic', release='fixture', archiveSha256='0' * 64)],
        rights=dict(scope='private-local-only', statement='Synthetic fixture only', notices=['notices/source.txt']),
        actions=[action])
    (root / 'notices/source.txt').write_text('Synthetic fixture only')
    (root / 'manifest.json').write_text(json.dumps(value, ensure_ascii=False))
    return root


def archive(folder, target):
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as out:
        for path in folder.rglob('*'):
            if path.is_file(): out.write(path, path.relative_to(folder).as_posix())
    return target


class SourceFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pet-sources-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.library = self.root / 'installed'
        self.first = fixture(self.root / 'project/pets/cat')
        self.second = fixture(self.root / 'elsewhere/dog', 'local.test.dog', '合成小狗')

    def test_scan_multiple_roots_archive_and_duplicate_paths(self):
        pack = archive(self.second, self.root / 'dog.petpack')
        result = sources.discover([str(self.root / 'project'), str(pack), str(self.first)])
        self.assertEqual({p['name'] for p in result['pets']}, {'合成小猫', '合成小狗'})
        self.assertEqual(len(result['pets']), 2)
        self.assertFalse(self.library.exists())

    def test_scan_ignores_symlinks_unrelated_apps_and_reports_invalid_packages(self):
        (self.root / 'project/link').symlink_to(self.second, target_is_directory=True)
        fixture(self.root / 'project/Other.app/Contents/cat', 'local.hidden', '不可发现')
        invalid = self.root / 'project/broken'; invalid.mkdir()
        (invalid / 'manifest.json').write_text('{}')
        result = sources.discover([str(self.root / 'project')])
        self.assertEqual([p['name'] for p in result['pets']], ['合成小猫'])
        self.assertTrue(result['warnings'])

    def test_bounded_scan_explains_incomplete_results(self):
        with patch.object(sources, 'MAX_SCAN_ENTRIES', 1):
            result = sources.discover([str(self.root)])
        self.assertTrue(any('上限' in warning for warning in result['warnings']))

    def test_prepare_multiple_directory_sources_and_repeat_without_overwrite(self):
        paths = [str(self.first), str(self.second)]
        result = sources.prepare(paths, self.library)
        self.assertEqual(len(result['packages']), 2)
        self.assertEqual(result['failures'], [])
        self.assertEqual({p['name'] for p in library.list_packages(self.library)}, {'合成小猫', '合成小狗'})
        repeated = sources.prepare(paths, self.library)
        self.assertEqual(result['packages'], repeated['packages'])
        self.assertEqual(repeated['failures'], [])
        self.assertFalse((self.library / 'pet-instances.json').exists())

    def test_prepare_archive_and_partial_failure_keeps_success(self):
        pack = archive(self.first, self.root / 'cat.petpack')
        (self.second / 'assets/idle.webp').write_bytes(b'corrupt')
        result = sources.prepare([str(pack), str(self.second)], self.library)
        self.assertEqual(len(result['packages']), 1)
        self.assertEqual(len(result['failures']), 1)
        self.assertEqual(len(library.list_packages(self.library)), 1)
        self.assertFalse(list(self.library.glob('.import-*')))

    def test_same_identity_different_content_is_rejected(self):
        sources.import_source(self.first, self.library)
        manifest = json.loads((self.first / 'manifest.json').read_text())
        manifest['name'] = 'different'
        (self.first / 'manifest.json').write_text(json.dumps(manifest))
        result = sources.prepare([str(self.first)], self.library)
        self.assertFalse(result['packages'])
        self.assertTrue(result['failures'])
        self.assertEqual(library.list_packages(self.library)[0]['name'], '合成小猫')

    def test_link_or_undeclared_file_is_not_imported(self):
        link = self.root / 'link'; link.symlink_to(self.first, target_is_directory=True)
        (self.second / 'unlisted.txt').write_text('not allowed')
        result = sources.prepare([str(link), str(self.second)], self.library)
        self.assertFalse(result['packages'])
        self.assertEqual(len(result['failures']), 2)
        self.assertEqual(library.list_packages(self.library), [])

    def test_scan_cli_is_json_only_and_does_not_start_windows(self):
        script = ROOT / 'apps/pet-runtime/pets/pet_sources.py'
        result = subprocess.run([sys.executable, str(script)], input=json.dumps(dict(operation='scan', paths=[str(self.first)])),
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['pets'][0]['name'], '合成小猫')

    def test_json_duplicate_keys_and_bad_batch_fail_closed(self):
        for raw in (b'{"paths":[],"paths":[]}', b'{"value":NaN}', b'\xff'):
            with self.assertRaises(ValueError): sources.parse_json(raw)
        for paths in ([], [str(self.first)] * 2, [str(i) for i in range(17)]):
            with self.assertRaises(ValueError): sources.prepare(paths, self.library)


class SourceTests(SourceFixture, unittest.TestCase):
    pass


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        SourceFixture.setUp(self)
        self.store = InstanceStore(self.root / 'profile')
        self.addCleanup(self.store.close)
        self.controller = InstanceController(self.store, lambda *_: self.fail('adding must not start a window'))
        self.controller.register(dict(id='original', package=dict(id='local.original', version='1.0.0'), preferences={}))
        self.env = patch.dict(os.environ, BAILONG_PET_LIBRARY_DIR=str(self.library))
        self.env.start(); self.addCleanup(self.env.stop)

    def command(self, packages):
        return dispatch(self.controller, dict(protocolVersion=1, requestId='fixture', command='add_pets', packages=packages))

    def test_batch_registers_stopped_names_and_is_idempotent(self):
        prepared = sources.prepare([str(self.first), str(self.second)], self.library)
        result = self.command(prepared['packages'])
        self.assertEqual(len(result['outcomes']), 2)
        added = [row for row in result['status']['instances'] if row['id'] != 'original']
        self.assertEqual({row['displayName'] for row in added}, {'合成小猫', '合成小狗'})
        self.assertTrue(all(row['phase'] == 'stopped' and not row['autoStartOnLaunch'] for row in added))
        self.assertFalse(self.controller.sessions)
        self.assertTrue(all(not row['changed'] for row in self.command(prepared['packages'])['outcomes']))
        self.assertEqual(self.store.load(), self.controller.registry)

    def test_missing_version_rolls_back_entire_registration(self):
        packages = sources.prepare([str(self.first)], self.library)['packages']
        original = self.store.path.read_bytes()
        with self.assertRaises(ValueError): self.command(packages + [dict(id='local.missing', version='1.0.0')])
        self.assertEqual(self.store.path.read_bytes(), original)
        self.assertEqual(set(self.controller.definitions), {'original'})

    def test_failed_write_keeps_disk_and_memory(self):
        packages = sources.prepare([str(self.first)], self.library)['packages']
        original = self.store.path.read_bytes()
        with patch.object(self.store, 'save_locked_data', side_effect=OSError('fixture disk failure')):
            with self.assertRaises(OSError): self.command(packages)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.assertEqual(set(self.controller.definitions), {'original'})

    def test_invalid_or_duplicate_selection_is_rejected(self):
        package = dict(id='local.test.cat', version='1.0.0')
        for packages in ([], [package, package], [dict(id='../x', version='1.0.0')], [package] * 17):
            with self.assertRaises(ValueError): self.command(packages)

    def test_only_original_bootstrap_does_not_create_an_unselected_clone(self):
        assets = self.root / 'builtin'; assets.mkdir()
        (assets / '素材清单.json').write_text('{}')
        (assets / 'idle.webp').write_bytes(b'synthetic identity bytes')
        store = InstanceStore(self.root / 'new-profile')
        try:
            result = store.create_initial_from_assets(assets, {}, include_clone=False)
            self.assertEqual([row['id'] for row in result['instances']], ['white-dragon'])
            self.assertTrue(result['instances'][0]['autoStartOnLaunch'])
        finally: store.close()

    def test_display_name_preserved_and_invalid_controls_rejected(self):
        value = dict(schemaVersion=1, instances=[dict(id='cat', displayName='合成小猫', package=dict(id='local.cat', version='1.0.0'))])
        self.assertEqual(validate_registry(value)['instances'][0]['displayName'], '合成小猫')
        for name in ('', '\n', 'cat\x7f', '猫' * 81):
            value['instances'][0]['displayName'] = name
            with self.assertRaises(ValueError): validate_registry(value)


if __name__ == '__main__':
    unittest.main(verbosity=2)
