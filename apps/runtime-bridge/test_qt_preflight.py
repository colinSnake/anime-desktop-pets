"""合成环境下的启动前检查，不导入 Qt、不创建窗口或读写用户资料。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('qt_preflight', Path(__file__).with_name('qt_preflight.py'))
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class QtPreflightTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        adapter = self.root / 'apps/pet-runtime/pets'
        adapter.mkdir(parents=True)
        for name in ('pet_helper.py', 'pet_instances.py', 'pet_instance_ipc.py'):
            (adapter / name).write_text('raise RuntimeError("must not execute")\n')

    def inspect(self, **options):
        defaults = dict(repository=self.root, platform='darwin', environment={},
                        python_version=(3, 12), locate_module=lambda name: True)
        defaults.update(options)
        return preflight.inspect_environment(**defaults)

    def test_available_is_not_permission_to_launch_or_integration(self):
        report = self.inspect()
        self.assertEqual(report['status'], 'prerequisites-found')
        self.assertFalse(report['desktopStarted'])
        self.assertFalse(report['playerIntegrated'])
        self.assertFalse(report['nativeModulesImported'])
        self.assertNotIn(str(self.root), json.dumps(report))

    def test_missing_dependencies_and_source_are_reported(self):
        (self.root / 'apps/pet-runtime/pets/pet_helper.py').unlink()
        report = self.inspect(locate_module=lambda name: False)
        self.assertEqual(report['status'], 'blocked')
        failed = {row['id'] for row in report['checks'] if row['status'] != 'found'}
        self.assertEqual(failed, {'pyside6', 'pillow', 'adapter-sources'})

    def test_windows_reports_existing_posix_ipc_as_blocker(self):
        report = self.inspect(platform='win32')
        self.assertEqual(report['status'], 'blocked')
        self.assertIn('legacy-ipc-needs-port', report['warnings'])

    def test_session_hints_never_claim_xwayland_from_display(self):
        for env, expected in [({'DISPLAY': ':0'}, 'unknown'),
                              ({'XDG_SESSION_TYPE': 'x11'}, 'x11'),
                              ({'XDG_SESSION_TYPE': 'wayland', 'DISPLAY': ':0'}, 'wayland'),
                              ({'WAYLAND_DISPLAY': 'wayland-0'}, 'wayland')]:
            report = self.inspect(platform='linux', environment=env)
            self.assertEqual(report['platform']['session'], expected)
            self.assertIn('desktop-matrix-unverified', report['warnings'])
            if expected == 'wayland':
                self.assertIn('wayland-window-restrictions', report['warnings'])

    def test_old_python_and_unknown_os_block(self):
        self.assertEqual(self.inspect(python_version=(3, 9))['status'], 'blocked')
        self.assertEqual(self.inspect(platform='other')['status'], 'blocked')

    def test_dependency_discovery_errors_are_sanitized(self):
        def broken(_name):
            raise RuntimeError('secret/path/token')
        report = self.inspect(locate_module=broken)
        self.assertEqual(report['status'], 'blocked')
        self.assertNotIn('secret', json.dumps(report))

    def test_cli_outputs_bounded_json_and_never_imports_adapter(self):
        result = subprocess.run([sys.executable, '-I', '-S', '-B', str(SPEC.origin), '--repository', str(self.root)],
                                capture_output=True, text=True, timeout=5)
        self.assertIn(result.returncode, (0, 2))
        report = json.loads(result.stdout)
        self.assertEqual(result.stderr, '')
        self.assertEqual(result.returncode, 2 if report['status'] == 'blocked' else 0)
        self.assertLess(len(result.stdout.encode()), 4096)
        self.assertNotIn(str(self.root), result.stdout)
        self.assertFalse(report['nativeModulesImported'])

    def test_discovery_does_not_import_native_packages(self):
        from unittest.mock import patch
        with patch.object(preflight, 'package_search_paths', return_value=[]), patch.object(preflight.importlib.machinery.PathFinder, 'find_spec', return_value=object()) as locate:
            before = set(sys.modules)
            self.assertTrue(preflight.module_available('PySide6'))
            self.assertTrue(preflight.module_available('PIL'))
            self.assertEqual(set(sys.modules), before)
            self.assertEqual(locate.call_count, 2)


class StartupIsolationTests(unittest.TestCase):
    def test_cli_discovers_venv_packages_without_executing_startup_hooks(self):
        import os
        import sysconfig
        import venv
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_root = root / 'env'
            venv.EnvBuilder(with_pip=False).create(env_root)
            packages = Path(sysconfig.get_path('purelib', scheme='nt' if os.name == 'nt' else 'posix_prefix',
                                                vars={'base': str(env_root), 'platbase': str(env_root)}))
            packages.mkdir(parents=True, exist_ok=True)
            marker = root / 'startup-executed'
            hook = f'import pathlib; pathlib.Path({str(marker)!r}).write_text("ran"); print("secret/startup/path")\n'
            (packages / 'synthetic.pth').write_text(hook)
            (packages / 'sitecustomize.py').write_text(hook)
            for name in ('PySide6', 'PIL'):
                (packages / name).mkdir()
                (packages / name / '__init__.py').write_text('raise RuntimeError("native-import-forbidden")\n')
            executable = env_root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            script = Path(__file__).resolve().parents[2] / 'scripts/check-qt-runtime.mjs'
            environment = dict(os.environ, PET_PYTHON=str(executable))
            result = subprocess.run(['node', str(script)], env=environment, capture_output=True, text=True, timeout=10)
            self.assertFalse(marker.exists(), 'Python startup hook executed before preflight')
            self.assertIn(result.returncode, (0, 2))
            self.assertNotIn('secret', result.stdout + result.stderr)
            report = json.loads(result.stdout)
            found = {row['id']: row['status'] for row in report['checks']}
            self.assertEqual(found['pyside6'], 'found')
            self.assertEqual(found['pillow'], 'found')


class SharedSystemPackagesTests(unittest.TestCase):
    def test_venv_inherits_only_explicitly_enabled_system_package_paths(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_root = root / 'env'
            (env_root / 'bin').mkdir(parents=True)
            local = env_root / 'site-packages'
            local.mkdir()
            system = root / 'base/site-packages'
            system.mkdir(parents=True)
            (system / 'PySide6').mkdir()
            (system / 'PySide6/__init__.py').write_text('raise RuntimeError("must-not-import")')
            with patch.object(preflight.sys, 'executable', str(env_root / 'bin/python')), \
                 patch.object(preflight.sysconfig, 'get_paths', return_value={'purelib': str(local), 'platlib': str(local)}), \
                 patch.object(preflight, 'system_package_paths', return_value=[str(system)], create=True):
                for enabled in (False, True):
                    (env_root / 'pyvenv.cfg').write_text('include-system-site-packages = ' + str(enabled).lower() + '\n')
                    self.assertEqual(preflight.module_available('PySide6'), enabled)


if __name__ == '__main__':
    unittest.main()
