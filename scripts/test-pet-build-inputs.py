#!/usr/bin/env python3
"""Synthetic build provenance regressions; no application or account access."""
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pet_build_inputs', ROOT / 'scripts/pet-build-inputs.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class BuildInputsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for key in module.fingerprints():
            p = self.root / key; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('synthetic')
        self.app = self.root / 'Helper.app'
        self.metadata = self.app / 'Contents/Resources/DRAGON_PATCH.json'
        self.metadata.parent.mkdir(parents=True)
        self.metadata.write_text(json.dumps(dict(buildInputs=module.fingerprints(self.root))))

    def test_matching_snapshot(self):
        self.assertTrue(module.check(self.app, self.root)['buildInputs'])

    def test_declared_local_font_must_exist_and_match_hash(self):
        font = self.app / 'Contents/Resources/fonts/上首软糖体.ttf'
        font.parent.mkdir(parents=True)
        font.write_bytes(b'approved local test font')
        import hashlib
        expected = hashlib.sha256(font.read_bytes()).hexdigest()
        with patch.object(module, 'LOCAL_TEST_FONT_SHA256', expected):
            self.metadata.write_text(json.dumps(dict(
                buildInputs=module.fingerprints(self.root), localTestFontSHA256=expected)))
            self.assertEqual(module.check(self.app, self.root)['localTestFontSHA256'], expected)
            font.write_bytes(b'changed font')
            with self.assertRaisesRegex(ValueError, 'SSRuanTangTi'):
                module.check(self.app, self.root)
            font.unlink()
            with self.assertRaisesRegex(ValueError, 'SSRuanTangTi'):
                module.check(self.app, self.root)

    def test_unapproved_local_font_hash_is_rejected(self):
        self.metadata.write_text(json.dumps(dict(
            buildInputs=module.fingerprints(self.root), localTestFontSHA256='unapproved')))
        with self.assertRaisesRegex(ValueError, '未审核'):
            module.check(self.app, self.root)

    def test_required_local_font_cannot_be_omitted(self):
        with self.assertRaisesRegex(ValueError, '必须包含 SSRuanTangTi'):
            module.check(self.app, self.root, require_local_test_font=True)

    def test_clone_module_change_is_detected(self):
        (self.root / 'apps/pet-runtime/pets/dragon_instance_ipc.py').write_text('clone changed')
        with self.assertRaisesRegex(ValueError, 'dragon_instance_ipc.py'):
            module.check(self.app, self.root)

    def test_relocated_playback_module_change_is_detected(self):
        (self.root / 'apps/pet-runtime/bailong/dragon_playback.py').write_text('clock changed')
        with self.assertRaisesRegex(ValueError, 'dragon_playback.py'):
            module.check(self.app, self.root)

    def test_provider_quota_change_is_detected(self):
        (self.root / 'apps/pet-runtime/bailong/dragon_quota.py').write_text('quota adapter changed')
        with self.assertRaisesRegex(ValueError, 'dragon_quota.py'):
            module.check(self.app, self.root)

    def test_task_follower_change_is_detected(self):
        (self.root / 'apps/pet-runtime/bailong/dragon_tasks.py').write_text('task reader changed')
        with self.assertRaisesRegex(ValueError, 'dragon_tasks.py'):
            module.check(self.app, self.root)

    def test_speech_cue_change_is_detected(self):
        (self.root / 'apps/pet-runtime/bailong/dragon_speech.py').write_text('speech cue changed')
        with self.assertRaisesRegex(ValueError, 'dragon_speech.py'):
            module.check(self.app, self.root)

    def test_pre_monorepo_path_snapshot_is_rejected(self):
        old = {}
        for key, value in module.fingerprints(self.root).items():
            key = key.replace('apps/pet-runtime/bailong/', 'integrations/bailong/')
            key = key.replace('apps/pet-runtime/pets/', 'integrations/pets/')
            old[key] = value
        self.metadata.write_text(json.dumps(dict(buildInputs=old)))
        with self.assertRaisesRegex(ValueError, 'apps/pet-runtime'):
            module.check(self.app, self.root)

    def test_legacy_metadata_is_not_a_fresh_build(self):
        self.metadata.write_text('{}')
        with self.assertRaises(ValueError): module.check(self.app, self.root)

    def test_patch_added_or_removed_is_detected(self):
        (self.root / 'integrations/bailong/new.patch').write_text('synthetic')
        with self.assertRaisesRegex(ValueError, 'new.patch'): module.check(self.app, self.root)
        (self.root / 'integrations/bailong/new.patch').unlink()
        (self.root / 'integrations/bailong/pet.py.patch').unlink()
        with self.assertRaisesRegex(ValueError, 'pet.py.patch'): module.check(self.app, self.root)

    def test_unified_patch_hunk_line_counts_match_contents(self):
        header = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
        for patch_path in sorted((ROOT / 'integrations/bailong').glob('*.patch')):
            lines = patch_path.read_text().splitlines()
            for index, line in enumerate(lines):
                match = header.match(line)
                if not match:
                    continue
                old_count = new_count = 0
                for content in lines[index + 1:]:
                    if content.startswith('@@ ') or content.startswith('--- '):
                        break
                    if content.startswith((' ', '-')):
                        old_count += 1
                    if content.startswith((' ', '+')):
                        new_count += 1
                    if content.startswith('\\'):
                        continue
                    self.assertTrue(content.startswith((' ', '+', '-')),
                                    f'{patch_path.name}: malformed hunk line {content!r}')
                self.assertEqual(old_count, int(match.group(2) or 1), patch_path.name)
                self.assertEqual(new_count, int(match.group(4) or 1), patch_path.name)


class BuildStagingTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('pet_runtime_builder', ROOT / 'scripts/build-pet-runtime.py')
        self.builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.builder)

    def test_generated_source_is_separate_from_retained_runtime_assets(self):
        self.assertEqual(self.builder.STAGE, self.builder.LOCAL / 'generated-source')
        self.assertNotEqual(self.builder.STAGE, self.builder.LOCAL / 'source')

    def test_missing_extension_audit_does_not_replace_existing_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stock = root / 'stock.app'
            (stock / 'Contents/Resources/outputs').mkdir(parents=True)
            stage = root / 'generated-source'; stage.mkdir()
            sentinel = stage / 'keep.txt'; sentinel.write_text('last valid source')
            (stage / '.dragon-generated').write_text('generated local source')
            with patch.multiple(self.builder, ROOT=root, STOCK=stock, STAGE=stage):
                with self.assertRaisesRegex(ValueError, '扩展动作源'):
                    self.builder.stage(root / 'upstream')
            self.assertEqual(sentinel.read_text(), 'last valid source')


if __name__ == '__main__': unittest.main(verbosity=2)
