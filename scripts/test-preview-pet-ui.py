#!/usr/bin/env python3
"""离屏预览回归；子进程、临时 HOME、合成额度，不启动真实桌宠或请求网络。"""
import ast
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PreviewTests(unittest.TestCase):
    def run_python(self, args, env):
        result = subprocess.run(
            [sys.executable, *args], cwd=ROOT, env=env,
            capture_output=True, text=True, timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_preview_overrides_inherited_native_style(self):
        # 先静态拒绝已知危险路径，回归时正常断言失败，不再制造系统崩溃弹窗。
        tree = ast.parse((ROOT / 'scripts/preview-pet-ui.py').read_text())
        qt_import = min(node.lineno for node in ast.walk(tree)
                        if isinstance(node, ast.ImportFrom)
                        and (node.module or '').startswith('PySide6'))
        updates = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                   and ast.unparse(node.func) == 'os.environ.update']
        self.assertEqual(len(updates), 1)
        self.assertLess(updates[0].lineno, qt_import)
        options = {kw.arg: ast.literal_eval(kw.value) for kw in updates[0].keywords
                   if kw.arg in ('QT_QPA_PLATFORM', 'QT_STYLE_OVERRIDE')}
        self.assertEqual(options['QT_QPA_PLATFORM'], 'offscreen')
        self.assertEqual(options['QT_STYLE_OVERRIDE'], 'Fusion')
        styles = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                  and ast.unparse(node.func) == 'QStyleFactory.create']
        self.assertEqual(len(styles), 1)
        self.assertEqual(ast.literal_eval(styles[0].args[0]), 'Fusion')
        with tempfile.TemporaryDirectory(prefix='dragon-preview-test-') as home:
            env = dict(os.environ, HOME=home, BAILONG_DATA_DIR=home,
                       QT_STYLE_OVERRIDE='macOS', QT_QPA_PLATFORM='offscreen',
                       BAILONG_CODEX='/usr/bin/false')
            out = Path(home) / 'cards'
            result = self.run_python(
                [str(ROOT / 'scripts/preview-pet-ui.py'), '--output-dir', str(out)], env,
            )
            self.assertIn('platform=offscreen, style=fusion', result.stdout)
            for theme in ('light', 'dark'):
                for name in ('menu', 'submenu', 'activity', 'message-short',
                             'message-lines', 'result-short', 'result-long',
                             'quota', 'quota-balance'):
                    self.assertTrue((out / f'{name}-{theme}.png').is_file())
            self.assertTrue((out / 'card-ui-preview.png').is_file())

    def test_refresh_button_survives_repeated_bubble_reuse(self):
        with tempfile.TemporaryDirectory(prefix='dragon-bubble-test-') as home:
            env = dict(os.environ, HOME=home, BAILONG_DATA_DIR=home,
                       QT_STYLE_OVERRIDE='Fusion', QT_QPA_PLATFORM='offscreen',
                       BAILONG_CODEX='/usr/bin/false')
            code = textwrap.dedent('''\
                from pathlib import Path
                import sys
                root = Path.cwd()
                sys.path[:0] = [str(root / 'apps/pet-runtime/bailong'),
                                str(root / '.local/pet-build/generated-source/app')]
                from datetime import datetime
                from PySide6.QtCore import QCoreApplication, QEvent
                from PySide6.QtWidgets import QApplication, QStyleFactory, QToolButton
                from dragon_ui import Bubble
                app = QApplication([])
                app.setStyle(QStyleFactory.create('Fusion'))
                app.setQuitOnLastWindowClosed(False)
                bubble = Bubble()
                now = datetime(2026, 11, 3, 12, 30)
                for _ in range(30):
                    bubble.message('短消息'); app.processEvents()
                    bubble.task_result('结果', '合成记录\\n' * 20, lambda: None)
                    app.processEvents()
                    for window in (
                        {'name': '5小时', 'remaining': 76, 'resetsAt': None},
                        {'name': '示例服务', 'remaining': 12.5, 'unit': 'USD',
                         'kind': 'balance', 'resetsAt': None},
                    ):
                        bubble.quota([window], now, refresh=lambda: None)
                        app.processEvents()
                        assert bubble.findChild(QToolButton) is not None
                        assert not bubble.grab().isNull()
                    QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                bubble.close(); bubble.deleteLater()
                QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                print('120 transitions / 60 refresh-button renders passed')
            ''')
            result = self.run_python(['-c', code], env)
            self.assertIn('120 transitions / 60 refresh-button renders passed', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
