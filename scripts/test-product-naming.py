#!/usr/bin/env python3
"""通用层命名回归；仅检查仓库文本及临时数据，不启动或安装应用。"""
from pathlib import Path
import subprocess
from urllib.parse import unquote, urlsplit
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SWIFT = ROOT / 'apps/companion-macos'


class ProductNamingTests(unittest.TestCase):
    def test_swift_modules_and_executable_are_product_named(self):
        package = (SWIFT / 'Package.swift').read_text()
        for name in ('AnimeDesktopPets', 'PetCore', 'PetCompanion', 'PetCoreTests', 'PetCompanionTests'):
            self.assertIn(f'"{name}"', package)
        for relative in ('Sources/PetCore', 'Sources/PetCompanion', 'Tests/PetCoreTests', 'Tests/PetCompanionTests'):
            self.assertTrue((SWIFT / relative).is_dir(), relative)
        for relative in ('Sources/DragonCore', 'Sources/DragonCompanion', 'Tests/DragonCoreTests', 'Tests/DragonCompanionTests'):
            self.assertFalse((SWIFT / relative).exists(), relative)

    def test_generic_python_modules_have_no_old_aliases(self):
        folder = ROOT / 'apps/pet-runtime/pets'
        for name in ('pet_instances', 'pet_instance_ipc', 'pet_helper'):
            self.assertTrue((folder / (name + '.py')).is_file(), name)
        for name in ('dragon_instances', 'dragon_instance_ipc', 'dragon_pet_helper'):
            self.assertFalse((folder / (name + '.py')).exists(), name)
        for path in folder.glob('*.py'):
            self.assertNotRegex(path.read_text(), r'\b(?:dragon_instances|dragon_instance_ipc|dragon_pet_helper)\b', str(path))

    def test_build_and_service_identifiers_match(self):
        build = (ROOT / 'scripts/build.sh').read_text()
        self.assertIn("CFBundleExecutable='PetCompanion'", build)
        self.assertIn("CFBundleIdentifier='local.anime-desktop-pets.companion'", build)
        self.assertIn('AnimeDesktopPets_CharacterUI.bundle', build)
        for name in ('install.sh', 'uninstall.sh'):
            text = (ROOT / 'scripts' / name).read_text()
            self.assertIn("LABEL='local.anime-desktop-pets.companion.watch'", text)
            self.assertIn('Contents/MacOS/PetCompanion', text)
        self.assertIn('Contents/MacOS/PetCompanion', (ROOT / 'scripts/petctl.sh').read_text())

    def test_active_code_has_no_generic_legacy_markers(self):
        forbidden = re.compile(r'\b(?:DragonCore|DragonCompanion|DragonCodexCompanion|DRAGON_[A-Z_]+|DragonPatchVersion)\b|local\.dragon\.')
        paths = list((SWIFT / 'Sources').rglob('*.swift'))
        paths += list((ROOT / 'apps/pet-runtime').rglob('*.py'))
        paths += list((ROOT / 'scripts').glob('*.sh'))
        paths += [p for p in (ROOT / 'scripts').glob('*.py') if not p.name.startswith('test-')]
        paths += list((ROOT / 'integrations/bailong').glob('*.patch'))
        for path in paths:
            self.assertNotRegex(path.read_text(), forbidden, str(path.relative_to(ROOT)))

    def test_host_window_titles_use_shared_product_copy(self):
        source = SWIFT / 'Sources/PetCompanion'
        for filename, assignment in (('BootPlayer.swift', 'movie.title'), ('PetController.swift', 'panel.title')):
            text = (source / filename).read_text()
            with self.subTest(window=filename):
                self.assertRegex(text, re.escape(assignment) + r'\s*=\s*AppCopy\.name\s*\+', filename)
                self.assertNotIn('Dragon ·', text, filename)

    def test_remaining_dragon_filenames_are_only_role_implementations(self):
        allowed = {f'apps/pet-runtime/bailong/dragon_{name}.py' for name in
                   ('behavior', 'frames', 'playback', 'quota', 'speech', 'tasks', 'ui', 'visibility')}
        remaining = {p for p in self.repository_files() if 'dragon' in p.lower()}
        self.assertEqual(remaining, allowed)

    @staticmethod
    def repository_files():
        # NUL分隔避免Git把中文路径显示为转义字符串；删除的旧路径不计入当前文件。
        paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT)
        return sorted({p.decode('utf-8') for p in paths.split(b'\0') if p and (ROOT / p.decode('utf-8')).is_file()})

    def test_local_markdown_links_point_to_existing_files(self):
        for relative in self.repository_files():
            if not relative.endswith('.md'):
                continue
            path = ROOT / relative
            for target in re.findall(r'\]\(([^)\s]+)\)', path.read_text()):
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                with self.subTest(document=relative, target=target):
                    self.assertTrue((path.parent / unquote(parsed.path)).exists(), target)

    def test_role_and_third_party_identifiers_are_not_rebranded(self):
        notices = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text()
        self.assertIn('dragon-codex-boot/media/startup.mp4', notices)
        instances = (ROOT / 'apps/pet-runtime/pets/pet_instances.py').read_text()
        for role_id in ('white-dragon', 'white-dragon-copy', 'local.bailong.white-dragon'):
            self.assertIn(role_id, instances)
        self.assertNotIn('white-pet', instances)

    def test_helper_metadata_and_patch_templates_are_consistent(self):
        build = (ROOT / 'scripts/build-pet-runtime.py').read_text()
        self.assertIn("VERSION = 'pet.44'", build)
        self.assertIn('PET_PATCH.json', build)
        self.assertIn('.pet-generated', build)
        spec = (ROOT / 'integrations/bailong/BailongPet.spec.patch').read_text()
        self.assertIn("'PetPatchVersion': '@PET_PATCH_VERSION@'", spec)
        inputs = (ROOT / 'scripts/pet-build-inputs.py').read_text()
        self.assertIn('PET_PATCH.json', inputs)
        for name in ('pet_instances.py', 'pet_instance_ipc.py', 'pet_helper.py'):
            self.assertIn(name, inputs)
        for name in ('dragon_frames.py', 'dragon_behavior.py', 'dragon_playback.py'):
            self.assertTrue((ROOT / 'apps/pet-runtime/bailong' / name).is_file(), name)


if __name__ == '__main__':
    unittest.main(verbosity=2)
