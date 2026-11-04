"""Bounded, same-user window controls; no account access or application activation."""
import json
import os
from pathlib import Path

from PySide6.QtCore import QObject, QTimer, QDir
from PySide6.QtNetwork import QLocalServer


class VisibilityControl(QObject):
    def __init__(self, pet):
        super().__init__(pet)
        self.pet = pet
        self.path = Path(QDir.tempPath()) / f'dragon-pet-{os.getuid()}-{os.getpid()}.sock'
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        self.server.setMaxPendingConnections(8)
        self.connections = {}
        # Do not unlink or replace any pre-existing path, even after PID reuse.
        if not self.server.listen(str(self.path)):
            raise RuntimeError('桌宠窗口控制通道不可用')
        os.chmod(self.path, 0o600)
        self.server.newConnection.connect(self.accept)

    def accept(self):
        while self.server.hasPendingConnections():
            connection = self.server.nextPendingConnection()
            if len(self.connections) >= 8:
                connection.abort(); connection.deleteLater(); continue
            connection.setReadBufferSize(257)
            timer = QTimer(self); timer.setSingleShot(True)
            self.connections[connection] = [bytearray(), timer, False]
            connection.readyRead.connect(lambda c=connection: self.read(c))
            connection.disconnected.connect(lambda c=connection: self.drop(c))
            timer.timeout.connect(lambda c=connection: self.drop(c))
            timer.start(1000)
            if connection.bytesAvailable(): self.read(connection)

    def drop(self, connection):
        state = self.connections.pop(connection, None)
        if state:
            state[1].stop(); state[1].deleteLater()
            connection.abort(); connection.deleteLater()

    def read(self, connection):
        state = self.connections.get(connection)
        if not state or state[2]: return
        state[0].extend(bytes(connection.readAll()))
        if len(state[0]) > 256:
            self.drop(connection); return
        if b'\n' not in state[0]: return
        state[2] = True
        line, extra = bytes(state[0]).split(b'\n', 1)
        try:
            request = json.loads(line)
            if (extra or not isinstance(request, dict)
                    or set(request) != {'pid', 'command'}
                    or type(request['pid']) is not int or request['pid'] != os.getpid()
                    or request['command'] not in ('show', 'hide', 'status', 'quit')):
                raise ValueError('invalid request')
            command = request['command']
            if command in ('show', 'hide'):
                # Window-level intent works even for LSUIElement agents. Do not
                # depend on NSRunningApplication.hide or on a tray being present.
                self.pet.manual_hidden = command == 'hide'
                self.pet.apply_visibility()
            response = dict(ok=True, pid=os.getpid(), visible=self.pet.isVisible(),
                            hidden=self.pet.manual_hidden)
            connection.write(json.dumps(response).encode() + b'\n')
            connection.disconnectFromServer()
            if command == 'quit': QTimer.singleShot(50, self.pet.close)
        except (ValueError, TypeError, KeyError, UnicodeError):
            self.drop(connection)


def attach_visibility_control(pet):
    # Multi-pet Adapter has a separate typed controller. The dedicated endpoint
    # is enabled only by a host launching a supported single-pet helper.
    if os.environ.get('DRAGON_WINDOW_CONTROL') != '1': return None
    return VisibilityControl(pet)
