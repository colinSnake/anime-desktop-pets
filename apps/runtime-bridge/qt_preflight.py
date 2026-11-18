"""Qt 接入前的只读检查。只发现模块位置，不导入 Qt/PIL 或现有播放器。

这是必要条件检查，不验证动态库、WebP 解码、素材指纹、字体或桌面窗口。
已有适配器的 Unix socket / uid / 权限逻辑尚不能直接移植到 Windows。
"""
import argparse
import importlib.machinery
import sysconfig
import json
from pathlib import Path
import sys
import os


def system_package_paths():
    # base prefix + 发行版 sysconfig scheme，兼顾 Windows / Linux 与 Homebrew framework。
    scheme = ('nt' if os.name == 'nt' else 'osx_framework_library'
              if sys.platform == 'darwin' and 'osx_framework_library' in sysconfig.get_scheme_names()
              else 'posix_prefix')
    paths = sysconfig.get_paths(scheme=scheme,
                                vars={'base': sys.base_prefix, 'platbase': sys.base_exec_prefix})
    return [paths['purelib'], paths['platlib']]


def package_search_paths():
    # -S 在 Python 3.10–3.13 不设置 venv prefix，不能盲用 sys.prefix。
    # 只读有界 pyvenv.cfg；不执行 .pth、sitecustomize 或用户 site。
    candidate = Path(sys.executable).absolute().parent.parent
    config = candidate / 'pyvenv.cfg'
    if config.is_file():
        paths = sysconfig.get_paths(scheme='nt' if os.name == 'nt' else 'posix_prefix',
                                    vars={'base': str(candidate), 'platbase': str(candidate)})
        result = [paths['purelib'], paths['platlib']]
        with config.open(encoding='utf-8') as source:
            settings = source.read(8193)
        if len(settings) > 8192:
            raise ValueError('invalid_venv_configuration')
        for line in settings.splitlines():
            key, separator, value = line.partition('=')
            if separator and key.strip().lower() == 'include-system-site-packages' and value.strip().lower() == 'true':
                result.extend(system_package_paths())
                break
    else:
        paths = sysconfig.get_paths()
        result = [paths['purelib'], paths['platlib']]
    return list(dict.fromkeys(result))


def module_available(name):
    # PathFinder 只在明确包目录发现顶层 spec，不导入包，也不执行 site 启动代码。
    return importlib.machinery.PathFinder.find_spec(name, package_search_paths()) is not None


def inspect_environment(*, repository, platform, environment, python_version,
                        locate_module=module_available):
    os_name = {'darwin': 'macos', 'win32': 'windows', 'linux': 'linux'}.get(platform, 'unsupported')
    session = 'unknown' if os_name == 'unsupported' else 'native'
    if os_name == 'linux':
        session = ('wayland' if environment.get('XDG_SESSION_TYPE') == 'wayland' or environment.get('WAYLAND_DISPLAY')
                   else 'x11' if environment.get('XDG_SESSION_TYPE') == 'x11' else 'unknown')
    checks = []

    def check(name, found):
        checks.append({'id': name, 'status': 'found' if found else 'missing'})

    check('python-3.10', tuple(python_version[:2]) >= (3, 10))
    for name, module in [('pyside6', 'PySide6'), ('pillow', 'PIL')]:
        try:
            check(name, bool(locate_module(module)))
        except Exception:
            # 不回显解释器路径、任意模块错误或用户环境信息。
            check(name, False)
    adapter = Path(repository) / 'apps/pet-runtime/pets'
    try:
        sources = all((adapter / name).is_file() for name in
                      ('pet_helper.py', 'pet_instances.py', 'pet_instance_ipc.py'))
    except OSError:
        sources = False
    check('adapter-sources', sources)
    check('legacy-ipc-platform', os_name in ('macos', 'linux'))
    warnings = ['player-not-integrated', 'desktop-matrix-unverified',
                'native-libraries-and-assets-unverified']
    if os_name == 'windows':
        warnings.append('legacy-ipc-needs-port')
    if session == 'wayland':
        warnings.append('wayland-window-restrictions')
    return {
        'protocolVersion': 1,
        'kind': 'qt-preflight',
        'status': 'prerequisites-found' if all(row['status'] == 'found' for row in checks) else 'blocked',
        'platform': {'os': os_name, 'session': session},
        'checks': checks,
        'warnings': warnings,
        'nativeModulesImported': False,
        'desktopStarted': False,
        'playerIntegrated': False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True, type=Path)
    args = parser.parse_args()
    report = inspect_environment(repository=args.repository, platform=sys.platform,
                                 environment=os.environ, python_version=sys.version_info)
    print(json.dumps(report, separators=(',', ':')))
    return 2 if report['status'] == 'blocked' else 0


if __name__ == '__main__':
    raise SystemExit(main())
