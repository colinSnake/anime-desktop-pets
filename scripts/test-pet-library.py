#!/usr/bin/env python3
"""素材库离线测试：全部使用临时目录/合成 WebP，不读取真实账号和素材。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/pets'))
import pet_library as library

PIXELS = dict(width=4, height=4, frameCount=2, durationMs=120)
PAYLOAD = b'not-an-image; protocol fixture only'


def manifest():
    return dict(schemaVersion=1, id='local.fixture.dragon', version='1.0.0', name='合成宠物',
                runtime='webp-v1', defaultAction='idle',
                sources=[dict(repository='local/synthetic-fixture', release='v1', archiveSha256='0' * 64)],
                rights=dict(scope='private-local-only', statement='测试，无第三方内容', notices=['notices/source.txt']),
                actions=[dict(id='idle', group='idle', file='assets/idle.webp',
                              sha256=hashlib.sha256(PAYLOAD).hexdigest(), sizeBytes=len(PAYLOAD), **PIXELS)])


def entries(data=None, payload=PAYLOAD):
    return {'manifest.json': json.dumps(data or manifest()).encode(),
            'notices/source.txt': b'Local synthetic test fixture', 'assets/idle.webp': payload}


def archive(path, files=None):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for key, value in (files or entries()).items():
            bundle.writestr(key, value)
    return path


class ManifestChecks(unittest.TestCase):
    def test_valid_manifest(self):
        self.assertEqual(library.validate_manifest(manifest()), set(entries()))

    def test_schema_runtime_identity_rights_required(self):
        for key, value in [('schemaVersion', 2), ('schemaVersion', True), ('runtime', 'python'),
                           ('id', '../../bad'), ('id', 'UPPER'), ('version', '../1'), ('name', '')]:
            with self.subTest(key=key, value=value):
                data = manifest(); data[key] = value
                with self.assertRaises(library.PackageError): library.validate_manifest(data)
        for key in ('sources', 'rights'):
            data = manifest(); del data[key]
            with self.assertRaises(library.PackageError): library.validate_manifest(data)

    def test_duplicate_action_and_missing_default(self):
        data = manifest(); data['actions'] *= 2
        with self.assertRaises(library.PackageError): library.validate_manifest(data)
        data = manifest(); data['defaultAction'] = 'missing'
        with self.assertRaises(library.PackageError): library.validate_manifest(data)

    def test_metadata_budget_preflight(self):
        for key, value in [('width', 100000), ('width', True), ('frameCount', 1001),
                           ('sizeBytes', library.MAX_FILE + 1), ('durationMs', 0), ('sha256', 'invalid')]:
            with self.subTest(key=key):
                data = manifest(); data['actions'][0][key] = value
                with self.assertRaises(library.PackageError): library.validate_manifest(data)
        data = manifest(); data['actions'][0].update(width=4096, height=4096, frameCount=1000)
        with self.assertRaises(library.PackageError): library.validate_manifest(data)

    def test_presentation_and_movement(self):
        for presentation in ({'scale': float('nan')}, {'offset': [0, float('inf')]},
                             {'loop': 1}, {'anchor': 'unknown'}, {'command': 'run'}):
            data = manifest(); data['actions'][0]['presentation'] = presentation
            with self.assertRaises(library.PackageError): library.validate_manifest(data)
        data = manifest(); data['actions'][0]['movement'] = {'startMs': 0, 'stopMs': 99, 'facing': 'right'}
        with self.assertRaises(library.PackageError): library.validate_manifest(data)

    def test_movement_group_requires_complete_runtime_metadata(self):
        def movement_action():
            action = dict(manifest()['actions'][0], id='walk-right', group='movement',
                          file='assets/walk-right.webp', movement=dict(startMs=0, stopMs=120, facing='right'))
            data = manifest(); data['actions'].append(action)
            return data

        data = movement_action()
        self.assertEqual(library.validate_manifest(data), set(entries()) | {'assets/walk-right.webp'})

        invalid = [None,
                   {'startMs': 0, 'stopMs': 120},
                   {'startMs': 0, 'stopMs': 120, 'facing': 'up'},
                   {'startMs': True, 'stopMs': 120, 'facing': 'right'},
                   {'startMs': 0, 'stopMs': 120, 'facing': 'right', 'velocity': 1},
                   {'startMs': 120, 'stopMs': 120, 'facing': 'right'},
                   {'startMs': 0, 'stopMs': 121, 'facing': 'right'}]
        for movement in invalid:
            with self.subTest(movement=movement):
                data = movement_action()
                if movement is None:
                    del data['actions'][1]['movement']
                else:
                    data['actions'][1]['movement'] = movement
                with self.assertRaises(library.PackageError): library.validate_manifest(data)

        data = movement_action(); data['actions'][1]['movement']['startMs'] = 120
        data['actions'][1]['movement']['stopMs'] = 120
        with self.assertRaises(library.PackageError): library.validate_manifest(data)

    def test_non_movement_group_rejects_movement_metadata(self):
        data = manifest()
        data['actions'][0]['movement'] = {'startMs': 0, 'stopMs': 120, 'facing': 'left'}
        with self.assertRaises(library.PackageError): library.validate_manifest(data)

    def test_path_traversal_and_normalization(self):
        for name in ('../bad', '/abs', 'C:/bad', 'a\\b', 'a//b', './a', 'a/../b', 'a\x00b', 'e\u0301.webp'):
            with self.subTest(name=name):
                with self.assertRaises(library.PackageError): library.path_name(name)

    def test_duplicate_json_keys_and_nonfinite_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'm.json'
            for value in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'):
                path.write_text(value)
                with self.assertRaises(library.PackageError): library.read_json(path)

    def test_json_symlink_and_hardlink_rejected(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = root / 'original.json'; original.write_text('{}')
            link = root / 'link.json'; link.symlink_to(original)
            with self.assertRaises(library.PackageError): library.read_json(link)
            link.unlink(); os.link(original, link)
            with self.assertRaises(library.PackageError): library.read_json(link)


class ArchiveChecks(unittest.TestCase):
    def assert_bad_archive(self, files):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); target = root / 'stage'; target.mkdir()
            pack = archive(root / 'test.petpack', files)
            with self.assertRaises((library.PackageError, zipfile.BadZipFile)):
                library.extract_archive(pack, target)
            self.assertFalse(any(target.iterdir()), '中央目录预检失败时不得先写文件')

    def test_forbidden_archive_paths_and_code(self):
        for name in ('../escape.txt', '/abs.txt', 'assets/../../bad.webp', 'assets\\bad.webp',
                     'plugin.py', 'assets/script.sh', 'assets/idle.webp:evil', './manifest.json'):
            with self.subTest(name=name):
                self.assert_bad_archive(dict(entries(), **{name: b'x'}))

    def test_duplicate_and_case_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.petpack'
            for duplicate in ('manifest.json', 'MANIFEST.JSON'):
                with self.subTest(duplicate=duplicate):
                    with zipfile.ZipFile(path, 'w') as bundle:
                        bundle.writestr('manifest.json', b'{}')
                        with warnings.catch_warnings():
                            warnings.simplefilter('ignore')
                            bundle.writestr(duplicate, b'{}')
                    target = Path(tmp) / 'stage'; target.mkdir(exist_ok=True)
                    with self.assertRaises(library.PackageError): library.extract_archive(path, target)
                    self.assertFalse(any(target.iterdir()))

    def test_symlink_device_executable_and_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.petpack'
            for mode in (stat.S_IFLNK | 0o777, stat.S_IFCHR | 0o600, stat.S_IFREG | 0o755, stat.S_IFDIR | 0o755):
                with self.subTest(mode=mode):
                    with zipfile.ZipFile(path, 'w') as bundle:
                        info = zipfile.ZipInfo('assets/idle.webp'); info.create_system = 3; info.external_attr = mode << 16
                        bundle.writestr(info, b'bad')
                        bundle.writestr('manifest.json', b'{}')
                    target = Path(tmp) / 'stage'; target.mkdir(exist_ok=True)
                    with self.assertRaises(library.PackageError): library.extract_archive(path, target)
                    self.assertFalse(any(target.iterdir()))

    def test_zip_bomb_ratio(self):
        self.assert_bad_archive(dict(entries(), **{'assets/bomb.webp': b'\0' * (1024**2)}))

    def test_entries_and_total_and_file_limits(self):
        for name, limit in [('MAX_ENTRIES', 2), ('MAX_TOTAL', 10), ('MAX_FILE', 2), ('MAX_ARCHIVE', 1)]:
            with self.subTest(name=name), patch.object(library, name, limit):
                self.assert_bad_archive(entries())

    def test_unsupported_compression(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.petpack'
            with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_BZIP2) as bundle:
                bundle.writestr('manifest.json', b'{}')
            with self.assertRaises(library.PackageError): library.extract_archive(path, Path(tmp))


class InstallChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.pack = archive(self.root / 'test.petpack')
        self.library = self.root / 'library'
        self.decode = patch.object(library, 'probe_webp', return_value=PIXELS)
        self.decode.start(); self.addCleanup(self.decode.stop)

    def test_install_and_list_without_activation(self):
        result = library.import_package(self.pack, self.library)
        self.assertFalse(result['activated'])

    def test_resolve_exact_package_version_and_verify_contents(self):
        library.import_package(self.pack, self.library)
        resolved = library.resolve_package(self.library, 'local.fixture.dragon', '1.0.0')
        self.assertEqual((resolved['id'], resolved['version']), ('local.fixture.dragon', '1.0.0'))
        self.assertEqual(resolved['manifest']['id'], 'local.fixture.dragon')
        self.assertEqual(resolved['path'].resolve(), (self.library / 'packages/local.fixture.dragon/1.0.0').resolve())
        with self.assertRaisesRegex(library.PackageError, '不存在'):
            library.resolve_package(self.library, 'local.fixture.dragon', '2.0.0')
        self.assertEqual(library.list_packages(self.library)[0]['version'], '1.0.0')
        self.assertFalse(list(self.library.glob('.import-*')))

    def test_resolve_rejects_identity_mismatch_and_symlink(self):
        library.import_package(self.pack, self.library)
        target = self.library / 'packages/local.fixture.dragon/1.0.0'
        manifest_path = target / 'manifest.json'
        data = json.loads(manifest_path.read_text())
        data['version'] = '2.0.0'
        manifest_path.write_text(json.dumps(data))
        with self.assertRaisesRegex(library.PackageError, '身份不符'):
            library.resolve_package(self.library, 'local.fixture.dragon', '1.0.0')
        manifest_path.write_text(json.dumps(manifest()))

        outside = self.root / 'outside'; outside.mkdir()
        target.rename(self.root / 'real-package')
        target.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(library.PackageError, '符号链接'):
            library.resolve_package(self.library, 'local.fixture.dragon', '1.0.0')

    def _instance_registry(self, rows):
        path = self.root / 'profile' / 'pet-instances.json'
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(dict(schemaVersion=1, instances=rows)))
        return path

    def test_delete_unreferenced_package(self):
        library.import_package(self.pack, self.library)
        registry = self._instance_registry([])
        result = library.delete_package(self.library, 'local.fixture.dragon', '1.0.0', registry)
        self.assertTrue(result['deleted'])
        self.assertEqual(library.list_packages(self.library), [])
        self.assertFalse(list(self.library.glob('.delete-*')))

    def test_delete_rejects_stopped_and_enabled_references(self):
        library.import_package(self.pack, self.library)
        for enabled in (False, True):
            registry = self._instance_registry([dict(id='pet-one', package=dict(id='local.fixture.dragon', version='1.0.0'), enabled=enabled)])
            with self.subTest(enabled=enabled), self.assertRaisesRegex(library.PackageError, '仍被实例清单引用'):
                library.delete_package(self.library, 'local.fixture.dragon', '1.0.0', registry)
        self.assertEqual(len(library.list_packages(self.library)), 1)

    def test_delete_fails_closed_for_missing_or_invalid_registry(self):
        library.import_package(self.pack, self.library)
        missing = self.root / 'missing.json'
        with self.assertRaisesRegex(library.PackageError, '实例清单缺失'):
            library.delete_package(self.library, 'local.fixture.dragon', '1.0.0', missing)
        registry = self._instance_registry([])
        registry.write_text('{broken')
        with self.assertRaisesRegex(library.PackageError, '损坏'):
            library.delete_package(self.library, 'local.fixture.dragon', '1.0.0', registry)
        self.assertEqual(len(library.list_packages(self.library)), 1)

    def test_delete_rejects_reference_lock_contention_and_package_symlink(self):
        from pet_reference_lock import reference_lock, ReferenceLockError
        library.import_package(self.pack, self.library)
        registry = self._instance_registry([])
        with reference_lock(registry), self.assertRaisesRegex(library.PackageError, '正在更新'):
            library.delete_package(self.library, 'local.fixture.dragon', '1.0.0', registry)
        target = self.library / 'packages/local.fixture.dragon/1.0.0'
        outside = self.root / 'outside'; outside.mkdir()
        target.rename(self.root / 'real-package')
        target.symlink_to(outside)
        with self.assertRaisesRegex(library.PackageError, '符号链接'):
            library.delete_package(self.library, 'local.fixture.dragon', '1.0.0', registry)

    def test_missing_library_list_does_not_create_it(self):
        self.assertEqual(library.list_packages(self.library), [])
        self.assertFalse(self.library.exists())

    def test_same_version_never_replaces_and_versions_coexist(self):
        result = library.import_package(self.pack, self.library)
        with self.assertRaisesRegex(library.PackageError, '不会覆盖'): library.import_package(self.pack, self.library)
        self.assertTrue(Path(result['path']).exists())
        data = manifest(); data['version'] = '1.1.0'
        archive(self.pack, entries(data))
        library.import_package(self.pack, self.library)
        self.assertEqual(len(library.list_packages(self.library)), 2)

    def test_hash_failure_rolls_back(self):
        files = entries(); files['assets/idle.webp'] = b'tampered'
        archive(self.pack, files)
        with self.assertRaises(library.PackageError): library.import_package(self.pack, self.library)
        self.assertFalse(list((self.library / 'packages').iterdir()))
        self.assertFalse(list(self.library.glob('.import-*')))

    def test_decode_failure_preserves_old_version(self):
        result = library.import_package(self.pack, self.library)
        data = manifest(); data['version'] = '1.1.0'; archive(self.pack, entries(data))
        with patch.object(library, 'probe_webp', side_effect=library.PackageError('bad image')):
            with self.assertRaises(library.PackageError): library.import_package(self.pack, self.library)
        self.assertEqual([p['version'] for p in library.list_packages(self.library)], ['1.0.0'])
        self.assertTrue(Path(result['path']).is_dir())
        self.assertFalse(list(self.library.glob('.import-*')))

    def test_declared_dimensions_must_match_decode(self):
        with patch.object(library, 'probe_webp', return_value=dict(PIXELS, width=5)):
            with self.assertRaises(library.PackageError): library.import_package(self.pack, self.library)

    def test_missing_and_undeclared_asset(self):
        for mode in ('missing', 'extra'):
            files = entries()
            if mode == 'missing': del files['assets/idle.webp']
            else: files['assets/extra.webp'] = PAYLOAD
            archive(self.pack, files)
            with self.assertRaises(library.PackageError): library.import_package(self.pack, self.library)

    def test_empty_and_non_utf8_notice_rejected(self):
        for payload in (b' ', b'\xff'):
            files = entries(); files['notices/source.txt'] = payload; archive(self.pack, files)
            with self.assertRaises(library.PackageError): library.import_package(self.pack, self.library)

    def test_atomic_rename_failure_cleans_up(self):
        with patch.object(library.os, 'rename', side_effect=OSError('disk error')):
            with self.assertRaises(OSError): library.import_package(self.pack, self.library)
        self.assertFalse(list((self.library / 'packages').iterdir()))
        self.assertFalse(list(self.library.glob('.import-*')))

    def test_stream_failure_cleans_up(self):
        def broken_extract(archive, stage):
            (stage / 'partial').write_bytes(b'partial')
            raise OSError('disk full')
        with patch.object(library, 'extract_archive', side_effect=broken_extract):
            with self.assertRaises(OSError): library.import_package(self.pack, self.library)
        self.assertFalse(list(self.library.glob('.import-*')))

    def test_library_and_family_symlink_rejected(self):
        outside = self.root / 'outside'; outside.mkdir()
        self.library.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(library.PackageError): library.import_package(self.pack, self.library)
        self.assertFalse(any(outside.iterdir()))
        self.library.unlink(); (self.library / 'packages').mkdir(parents=True)
        (self.library / 'packages/local.fixture.dragon').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(library.PackageError): library.import_package(self.pack, self.library)
        self.assertFalse(any(outside.iterdir()))

    def test_lock_serializes_cooperating_importers(self):
        with library.library_lock(self.library):
            with self.assertRaisesRegex(library.PackageError, '正在操作'):
                library.import_package(self.pack, self.library)

    def test_existing_history_and_preferences_untouched(self):
        history = self.library / 'conversations.json'; self.library.mkdir()
        history.write_bytes(b'private test fixture')
        preference = self.library / 'preferences.ini'; preference.write_bytes(b'existing fixture')
        library.import_package(self.pack, self.library)
        self.assertEqual(history.read_bytes(), b'private test fixture')
        self.assertEqual(preference.read_bytes(), b'existing fixture')

    def test_invalid_zip_and_failed_import_return_json(self):
        self.pack.write_bytes(b'not a zip')
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/pet-library.py'), '--library',
                                 str(self.library), 'import', str(self.pack)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stderr)['ok'])


@unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow 未安装，仅跳过真实图像解码检查')
class RealDecoderChecks(unittest.TestCase):
    def fixture(self, root):
        from PIL import Image
        path = root / 'animated.webp'
        a = Image.new('RGBA', (4, 4), (255, 0, 0, 100))
        b = Image.new('RGBA', (4, 4), (0, 255, 0, 100))
        a.save(path, format='WEBP', save_all=True, append_images=[b], duration=[40, 80], loop=0, lossless=True)
        return path

    def test_full_decode_keeps_nonuniform_durations(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(library.probe_webp(self.fixture(Path(tmp))), PIXELS)

    def test_corrupt_and_wrong_format_rejected(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.webp'
            path.write_bytes(b'broken')
            with self.assertRaises(library.PackageError): library.probe_webp(path)
            Image.new('RGB', (4, 4)).save(path, format='PNG')
            with self.assertRaises(library.PackageError): library.probe_webp(path)

    def test_real_package_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); image = self.fixture(root); payload = image.read_bytes()
            data = manifest(); data['actions'][0].update(sizeBytes=len(payload), sha256=library.digest(image))
            pack = archive(root / 'real.petpack', entries(data, payload))
            result = library.import_package(pack, root / 'library')
            self.assertEqual(library.validate_directory(Path(result['path'])), data)

    def test_decode_work_budget_checks_actual_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.fixture(Path(tmp))
            with patch.object(library, 'MAX_CLIP_PIXELS', 1):
                with self.assertRaises(library.PackageError): library.probe_webp(path)


class ReportChecks(unittest.TestCase):
    def test_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'audit.json'
            library.write_report(path, {'test': True})
            with self.assertRaises(library.PackageError): library.write_report(path, {'test': False})
            self.assertTrue(json.loads(path.read_text())['test'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
