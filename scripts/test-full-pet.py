#!/usr/bin/env python3
"""完整桌宠接入的离线测试；不下载、不启动桌宠、不访问 Codex。"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_full_pet', ROOT/'scripts/prepare-full-pet.py')
pet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pet)

class FullPetTests(unittest.TestCase):
    def fixture(self, directory):
        app=Path(directory)/'BailongPet.app'
        executable=app/'Contents/MacOS/BailongPet';executable.parent.mkdir(parents=True)
        executable.write_bytes(b'fixture only, never execute');executable.chmod(0o755)
        info={'CFBundleIdentifier':'local.bailongpet.macos','CFBundleVersion':'3','CFBundleExecutable':'BailongPet'}
        with (app/'Contents/Info.plist').open('wb') as stream:plistlib.dump(info,stream)
        root=app/'Contents/Resources/outputs/白龙桌宠素材';root.mkdir(parents=True)
        (root/'action.webp').write_bytes(b'fixture')
        item={'file':'action.webm','durationMs':1000}
        manifest={'idle':item,'additionalIdleAnimations':[item],'variants':[item]*15,
                  'workAnimations':[item]*5,'dragAnimation':item,'landingAnimation':item,'quotaAnimation':item}
        (root/'素材清单.json').write_text(json.dumps(manifest))
        return app,root,manifest

    def test_pinned_release(self):
        self.assertEqual(pet.SHA256,'c7df79f2b7e3fb90736e3ed8fb21be2fd6f8fe2d3982c494f0ee1c68004ccdb2')
        self.assertTrue(pet.URL.startswith('https://github.com/chihayaanon210-spec/'))
        self.assertIn('/v0.4.1-mac.3/',pet.URL)

    def test_complete_app_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_,_=self.fixture(directory)
            details=pet.inspect_app(app,verify_signature=False)
            self.assertEqual(details['actionCount'],25)
            self.assertEqual(details['groups'],{'movement':0,'idle':2,'interaction':15,'work':5,'special':3})

    def test_enhanced_app_requires_matching_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_,_=self.fixture(directory)
            info=app/'Contents/Info.plist'
            data=plistlib.loads(info.read_bytes());data.update(CFBundleVersion='4',PetPatchVersion='pet.1')
            info.write_bytes(plistlib.dumps(data))
            marker=app/'Contents/Resources/PET_PATCH.json'
            marker.write_text(json.dumps({'patchVersion':'pet.1','upstreamVersion':'0.4.1-mac.3','bundleVersion':'4'}))
            self.assertEqual(pet.inspect_app(app,verify_signature=False)['patchVersion'],'pet.1')
            marker.write_text(json.dumps({'patchVersion':'pet.9','upstreamVersion':'0.4.1-mac.3'}))
            with self.assertRaises(ValueError):pet.inspect_app(app,verify_signature=False)

    def test_card_menu_build_uses_distinct_patch_version(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_,_=self.fixture(directory)
            info=app/'Contents/Info.plist'
            data=plistlib.loads(info.read_bytes());data.update(CFBundleVersion='5',PetPatchVersion='pet.2')
            info.write_bytes(plistlib.dumps(data))
            marker=app/'Contents/Resources/PET_PATCH.json'
            marker.write_text(json.dumps({'patchVersion':'pet.2','upstreamVersion':'0.4.1-mac.3','bundleVersion':'5'}))
            self.assertEqual(pet.inspect_app(app,verify_signature=False)['patchVersion'],'pet.2')
            data['PetPatchVersion']='pet.1';info.write_bytes(plistlib.dumps(data))
            with self.assertRaises(ValueError):pet.inspect_app(app,verify_signature=False)

    def test_behavior_build_uses_matching_metadata(self):
        for build,version in [('6','pet.3'),('7','pet.4'),('8','pet.5'),('9','pet.6'),('10','pet.7'),('11','pet.8'),('12','pet.9'),('13','pet.10'),('14','pet.11'),('15','pet.12'),('16','pet.13'),('17','pet.14'),('18','pet.15'),('19','pet.16'),('20','pet.17'),('21','pet.18'),('22','pet.19')]:
            with self.subTest(build=build), tempfile.TemporaryDirectory() as directory:
                app,_,_=self.fixture(directory)
                info=app/'Contents/Info.plist'
                data=plistlib.loads(info.read_bytes());data.update(CFBundleVersion=build,PetPatchVersion=version)
                info.write_bytes(plistlib.dumps(data))
                marker=app/'Contents/Resources/PET_PATCH.json'
                marker.write_text(json.dumps({'patchVersion':version,'upstreamVersion':'0.4.1-mac.3','bundleVersion':build}))
                self.assertEqual(pet.inspect_app(app,verify_signature=False)['patchVersion'],version)
                data['PetPatchVersion']='pet.2';info.write_bytes(plistlib.dumps(data))
                with self.assertRaises(ValueError):pet.inspect_app(app,verify_signature=False)

    def test_old_enhanced_bundle_reports_required_current_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            app, _, _ = self.fixture(directory)
            info = app / 'Contents/Info.plist'
            value = plistlib.loads(info.read_bytes())
            value.update(CFBundleVersion='37', DragonPatchVersion='dragon.43')
            info.write_bytes(plistlib.dumps(value))
            with self.assertRaisesRegex(ValueError, r'build 37.*PetPatchVersion.*PET_PATCH\.json'):
                pet.inspect_app(app, verify_signature=False)

    def test_missing_asset_is_error(self):
        with tempfile.TemporaryDirectory() as directory:
            app,root,_=self.fixture(directory);(root/'action.webp').unlink()
            with self.assertRaises(ValueError):pet.inspect_app(app,verify_signature=False)

    def test_wrong_bundle_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_,_=self.fixture(directory)
            with (app/'Contents/Info.plist').open('wb') as stream:plistlib.dump({'CFBundleIdentifier':'com.openai.codex'},stream)
            with self.assertRaises(ValueError):pet.inspect_app(app,verify_signature=False)

    def test_catalog_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            app,root,manifest=self.fixture(directory)
            manifest['idle']={'playbackFile':'../escape.webp','durationMs':1000}
            (root/'素材清单.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):pet.inspect_app(app,verify_signature=False)

    def archive(self, name, target=None):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path=Path(directory.name)/'fixture.zip'
        with zipfile.ZipFile(path,'w') as archive:
            if target:
                info=zipfile.ZipInfo(name);info.create_system=3
                info.external_attr=(stat.S_IFLNK|0o777)<<16
                archive.writestr(info,target)
            else:archive.writestr(name,b'fixture')
        return path

    def validate_fixture(self,path):
        with patch.object(pet,'SIZE',path.stat().st_size),patch.object(pet,'SHA256',pet.sha256(path)):
            pet.validate_archive(path)

    def test_valid_archive_layout(self):
        self.validate_fixture(self.archive('BailongPet.app/Contents/Info.plist'))

    def test_checksum_rejection(self):
        path=self.archive('BailongPet.app/file')
        with patch.object(pet,'SIZE',path.stat().st_size),patch.object(pet,'SHA256','0'*64):
            with self.assertRaises(ValueError):pet.validate_archive(path)

    def test_zip_traversal_rejected(self):
        for name in ['../escape','/tmp/escape','bad\\escape']:
            with self.assertRaises(ValueError):self.validate_fixture(self.archive(name))

    def test_unsafe_symlinks_rejected(self):
        for target in ['/tmp/escape','../../escape']:
            with self.assertRaises(ValueError):self.validate_fixture(self.archive('app/link',target))

    def test_offline_selftest_is_not_chat_or_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_,_=self.fixture(directory)
            details=pet.inspect_app(app,verify_signature=False)
            def execute(command,**kwargs):
                env=kwargs['env']
                self.assertEqual(command[-1],'--self-test')
                self.assertIn('(deny network*)',command[2])
                self.assertEqual(env['QT_QPA_PLATFORM'],'offscreen')
                self.assertEqual(env['BAILONG_CODEX'],'/usr/bin/false')
                self.assertNotIn('PET_IMAGE_API_KEY',env)
                (Path(env['BAILONG_DATA_DIR'])/'检查报告.json').write_text('{"passed":true,"checks":[]}')
                return type('Result',(),{'returncode':0,'stdout':'','stderr':''})()
            with patch.object(pet,'LOCAL',Path(directory)/'local'),patch.object(pet,'inspect_app',return_value=details),patch.object(pet.subprocess,'run',side_effect=execute):
                with contextlib.redirect_stdout(io.StringIO()):pet.self_test(app)

if __name__=='__main__':unittest.main(verbosity=2)
