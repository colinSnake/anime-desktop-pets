"""Qt desktop browser for the isolated, private pet-package library."""
from pathlib import Path
import json
import sys

from PySide6.QtCore import QObject, QRunnable, QThreadPool, QTimer, Qt, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QFileDialog, QHBoxLayout, QLabel, QListWidget,
    QMainWindow, QMessageBox, QPushButton, QSplitter, QTableWidget,
    QTableWidgetItem, QVBoxLayout, QWidget,
)

from pet_library import delete_package, import_package, list_packages, resolve_package
from dragon_instance_ipc import send_command


class _Signals(QObject):
    completed = Signal(object, object)
    details_completed = Signal(int, object, object)


class _Job(QRunnable):
    def __init__(self, operation):
        super().__init__()
        self.operation = operation
        self.generation = None
        self.signals = _Signals()

    def run(self):
        try:
            result = self.operation()
            if self.generation is None:
                self.signals.completed.emit(result, None)
            else:
                self.signals.details_completed.emit(self.generation, result, None)
        except Exception as error:
            if self.generation is None:
                self.signals.completed.emit(None, str(error))
            else:
                self.signals.details_completed.emit(self.generation, None, str(error))


class AnimationPreview(QDialog):
    def __init__(self, package_path, action, parent=None):
        super().__init__(parent)
        self.setWindowTitle(action.get('name') or action['id'])
        self.setMinimumSize(360, 400)
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.path = Path(package_path) / action['file']
        self.label = QLabel("正在读取动画…")
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.info = QLabel(f"{action['group']} · {action['width']} × {action['height']} · {action['frameCount']} 帧")
        layout = QVBoxLayout(self)
        layout.addWidget(self.label, 1)
        layout.addWidget(self.info)
        self.image = None
        self.index = 0
        try:
            from PIL import Image
            self.image = Image.open(self.path)
            self.timer = QTimer(self)
            self.timer.timeout.connect(self.next_frame)
            self.next_frame()
            self.timer.start(max(20, self.image.info.get('duration', 80)))
        except Exception as error:
            self.label.setText(f"无法预览：{error}")

    def next_frame(self):
        if self.image is None:
            return
        try:
            self.image.seek(self.index)
            frame = self.image.convert('RGBA').copy()
            frame.thumbnail((480, 480))
            data = frame.tobytes('raw', 'RGBA')
            image = QImage(data, frame.width, frame.height, QImage.Format.Format_RGBA8888).copy()
            self.label.setPixmap(QPixmap.fromImage(image))
            duration = max(20, int(self.image.info.get('duration', 80)))
            self.index = (self.index + 1) % self.image.n_frames
            self.timer.setInterval(duration)
        except Exception as error:
            self.timer.stop()
            self.label.setText(f"动画解码失败：{error}")

    def closeEvent(self, event):
        if hasattr(self, 'timer'):
            self.timer.stop()
        if self.image is not None:
            self.image.close()
        super().closeEvent(event)


class PetLibraryWindow(QMainWindow):
    def __init__(self, library_path, instances_path=None, control_directory=None):
        super().__init__()
        self.library_path = Path(library_path).expanduser()
        self.instances_path = Path(instances_path).expanduser() if instances_path else None
        self.control_directory = Path(control_directory).expanduser() if control_directory else None
        self.pool = QThreadPool(self)
        self.package_rows = []
        self.manifest = None
        self.package_path = None
        self.preview = None
        self._details_generation = 0
        self._closing = False
        self.setWindowTitle('宠物素材库')
        self.resize(760, 520)

        self.packages = QTableWidget(0, 3)
        self.packages.setHorizontalHeaderLabels(['名称', '版本', '动作'])
        self.packages.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.packages.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.packages.itemSelectionChanged.connect(self.show_selected_package)
        self.actions = QListWidget()
        self.actions.currentRowChanged.connect(self.update_preview_enabled)
        self.preview_button = QPushButton('预览动作')
        self.preview_button.setEnabled(False)
        self.preview_button.clicked.connect(self.preview_action)
        self.import_button = QPushButton('导入 .petpack…')
        self.import_button.clicked.connect(self.choose_package)
        self.delete_button = QPushButton('删除所选包…')
        self.delete_button.setEnabled(False)
        self.delete_button.clicked.connect(self.confirm_delete)
        self.activation_note = QLabel('素材包仅保存在本地库；当前桌宠运行时尚不支持切换素材包。')
        self.instance_picker = QComboBox()
        self.package_picker = QComboBox()
        self.activate_button = QPushButton('停止后切换素材包')
        self.activate_button.setEnabled(False)
        self.activate_button.clicked.connect(self.activate_package)
        self.instance_picker.currentIndexChanged.connect(self.update_activation_enabled)
        self.package_picker.currentIndexChanged.connect(self.update_activation_enabled)
        self.activation_note.setText('仅支持停止状态切换；运行中的实例需先从桌宠菜单停止。')
        self.activation_note.setWordWrap(True)
        self.status = QLabel('')

        toolbar = QHBoxLayout()
        toolbar.addWidget(self.import_button)
        toolbar.addWidget(self.delete_button)
        toolbar.addWidget(self.instance_picker)
        toolbar.addWidget(self.package_picker)
        toolbar.addWidget(self.activate_button)
        toolbar.addStretch(1)
        toolbar.addWidget(self.preview_button)
        details = QWidget()
        detail_layout = QVBoxLayout(details)
        detail_layout.addWidget(QLabel('动作'))
        detail_layout.addWidget(self.actions, 1)
        detail_layout.addWidget(self.activation_note)
        splitter = QSplitter()
        splitter.addWidget(self.packages)
        splitter.addWidget(details)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        central = QWidget()
        layout = QVBoxLayout(central)
        layout.addLayout(toolbar)
        layout.addWidget(splitter, 1)
        layout.addWidget(self.status)
        self.setCentralWidget(central)
        self.refresh()

    def _run(self, operation, done):
        job = _Job(operation)
        job.signals.completed.connect(done)
        self.pool.start(job)

    def refresh(self):
        self._details_generation += 1
        self.status.setText('正在读取素材库…')
        self.import_button.setEnabled(False)
        self.delete_button.setEnabled(False)
        self._run(lambda: list_packages(self.library_path), self._loaded)

    def _loaded(self, rows, error):
        self.import_button.setEnabled(True)
        self.delete_button.setEnabled(self.instances_path is not None and self.packages.currentRow() >= 0)
        if error:
            self.status.setText('读取失败')
            QMessageBox.critical(self, '素材库读取失败', error)
            return
        self.package_rows = rows
        self.packages.setRowCount(len(rows))
        for index, row in enumerate(rows):
            values = (row['name'], row['version'], str(row['actionCount']))
            for column, value in enumerate(values):
                self.packages.setItem(index, column, QTableWidgetItem(value))
        self.packages.resizeColumnsToContents()
        self.package_picker.clear()
        for row in rows:
            self.package_picker.addItem(f"{row['name']} · {row['version']}", (row['id'], row['version']))
        self.refresh_instances()
        self.status.setText(f'{len(rows)} 个素材包 · 已导入不代表已激活')
        self.actions.clear()
        self.manifest = None
        self.package_path = None
        self.preview_button.setEnabled(False)
        self.update_activation_enabled()

    def refresh_instances(self):
        self.instance_picker.clear()
        if self.instances_path is None:
            self.update_activation_enabled()
            return
        try:
            from dragon_instances import validate_registry
            registry = validate_registry(json.loads(self.instances_path.read_text(encoding='utf-8')))
            for row in registry['instances']:
                self.instance_picker.addItem(row['id'], row['id'])
        except Exception:
            pass
        self.update_activation_enabled()

    def update_activation_enabled(self, *_):
        self.activate_button.setEnabled(bool(self.control_directory and self.instances_path and
                                             self.instance_picker.count() and self.package_picker.count()))

    def activate_package(self):
        instance_id = self.instance_picker.currentData()
        package = self.package_picker.currentData()
        if not instance_id or not package or not self.control_directory:
            return
        self.activate_button.setEnabled(False)
        self.status.setText('正在请求控制器验证并切换；仅停止实例可切换…')
        self._run(lambda: send_command(self.control_directory, 'set_package', instanceID=instance_id,
                                       package=dict(id=package[0], version=package[1])), self._activated)

    def _activated(self, reply, error):
        if error or not isinstance(reply, dict) or not reply.get('ok'):
            failure = error or (reply.get('error') or {}).get('message') or '控制器返回无效响应'
            self.status.setText('素材包未切换；原引用保持不变')
            QMessageBox.warning(self, '无法切换素材包', str(failure))
        else:
            self.status.setText(f"实例 {self.instance_picker.currentData()} 已切换；下次启动时加载新素材")
        self.refresh_instances()
        self.update_activation_enabled()

    def choose_package(self):
        path, _ = QFileDialog.getOpenFileName(self, '导入宠物素材包', str(Path.home()), '宠物素材包 (*.petpack)')
        if not path:
            return
        self.import_button.setEnabled(False)
        self.status.setText('正在安全校验并导入；大素材包可能需要一些时间…')
        self._run(lambda: import_package(path, self.library_path), self._imported)

    def _imported(self, result, error):
        self.import_button.setEnabled(True)
        if error:
            self.status.setText('导入失败；素材库保持原状')
            QMessageBox.critical(self, '导入失败', error)
            return
        self.status.setText(f"已导入 {result['id']} {result['version']} · {result['actionCount']} 个动作 · 未激活")
        self.refresh()

    def show_selected_package(self):
        self._details_generation += 1
        generation = self._details_generation
        rows = self.packages.selectionModel().selectedRows()
        self.actions.clear()
        self.manifest = None
        self.package_path = None
        self.preview_button.setEnabled(False)
        if not rows:
            self.delete_button.setEnabled(False)
            return
        self.delete_button.setEnabled(self.instances_path is not None)
        row = self.package_rows[rows[0].row()]
        self.status.setText('正在验证所选素材包…')
        job = _Job(lambda: self._resolve_selected(row['id'], row['version']))
        job.generation = generation
        job.signals.details_completed.connect(self._details_loaded)
        self.pool.start(job)

    def _resolve_selected(self, package_id, version):
        resolved = resolve_package(self.library_path, package_id, version)
        return resolved['manifest'], resolved['path']

    def _details_loaded(self, generation, value, error):
        if self._closing or generation != self._details_generation:
            return
        if error:
            self.status.setText('素材包验证失败')
            QMessageBox.critical(self, '素材包无效', error)
            return
        self.manifest, path = value
        self.package_path = Path(path)
        for action in self.manifest['actions']:
            label = action.get('name') or action['id']
            self.actions.addItem(f"{label} · {action['group']} · {action['frameCount']} 帧")
        self.status.setText(f"来源 {len(self.manifest['sources'])} 项 · 完整文件/哈希/动画解码校验通过 · 未激活")
        self.update_preview_enabled()

    def update_preview_enabled(self, *_):
        self.preview_button.setEnabled(self.manifest is not None and self.actions.currentRow() >= 0)

    def preview_action(self):
        index = self.actions.currentRow()
        if self.manifest is None or self.package_path is None or index < 0:
            return
        if self.preview is not None:
            self.preview.close()
        preview = AnimationPreview(self.package_path, self.manifest['actions'][index], self)
        self.preview = preview
        preview.finished.connect(self._preview_closed)
        self.preview.show()

    def _preview_closed(self, _result):
        self.preview = None

    def confirm_delete(self):
        row_index = self.packages.currentRow()
        if self.instances_path is None or not 0 <= row_index < len(self.package_rows):
            return
        row = self.package_rows[row_index]
        answer = QMessageBox.question(
            self, '删除素材包',
            f"确定删除「{row['name']}」 {row['version']}？正在被任意实例引用的版本（包括已停止实例）不可删除。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel)
        if answer != QMessageBox.StandardButton.Yes:
            return
        if self.preview is not None:
            self.preview.close()
            self.preview = None
        self._details_generation += 1
        self.import_button.setEnabled(False)
        self.delete_button.setEnabled(False)
        self.status.setText('正在检查实例引用并删除…')
        self._run(lambda: delete_package(self.library_path, row['id'], row['version'], self.instances_path),
                  self._deleted)

    def _deleted(self, result, error):
        self.import_button.setEnabled(True)
        if error:
            self.status.setText('删除未完成')
            QMessageBox.critical(self, '无法删除素材包', error)
            self.refresh()
            return
        self.status.setText(f"已删除 {result['id']} {result['version']}")
        self.refresh()

    def closeEvent(self, event):
        self._closing = True
        self._details_generation += 1
        if self.preview is not None:
            self.preview.close()
            self.preview = None
        self.pool.waitForDone()
        super().closeEvent(event)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) not in (1, 2, 3):
        raise SystemExit('用法：python scripts/pet-library-ui.py <素材库目录> [pet-instances.json] [控制目录]')
    app = QApplication.instance() or QApplication([sys.argv[0]])
    window = PetLibraryWindow(Path(args[0]), Path(args[1]) if len(args) >= 2 else None,
                              Path(args[2]) if len(args) == 3 else None)
    window.show()
    return app.exec()
