"""多宠实例的受限本机控制通道。仅控制预先注册的实例，不加载脚本或启动helper。"""
from collections import OrderedDict
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import time
import uuid

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtNetwork import QLocalServer

from dragon_instances import DEFAULT_PREFERENCES, ID, InstanceError, preferences, require, validate_registry

PROTOCOL = 1
MAX_REQUEST = 8192
MAX_RESPONSE = 128 * 1024
MAX_CONNECTIONS = 16
MAX_BATCH = 32
TIMEOUT_MS = 2000
SOCKET_NAME = 'pet-control.sock'
SPEECH_SOCKET_NAME = 'speech-presentation.sock'
MAX_SPEECH_EVENT = 4096
REQUEST_ID = re.compile(r'[A-Za-z0-9_-]{1,64}\Z')
COMMAND_FIELDS = {
    'add_pets': {'packages'},
    'status': set(), 'start_pet': {'instanceID'}, 'stop_pet': {'instanceID'},
    'start_selected': {'instanceIDs'}, 'stop_all': set(),
    'set_preferences': {'instanceID', 'preferences'}, 'set_package': {'instanceID', 'package'},
    'clone_pet': {'instanceID', 'cloneID'}, 'delete_pet': {'instanceID'}, 'shutdown': set(),
}


def validate_speech_event(data, now=None):
    require(isinstance(data, bytes) and len(data) <= MAX_SPEECH_EVENT, '语音呈现事件超限')
    value = json_object(data)
    require(isinstance(value, dict) and set(value) == {'protocolVersion', 'type', 'text', 'createdAt'},
            '语音呈现字段无效')
    require(type(value['protocolVersion']) is int and value['protocolVersion'] == 1 and
            value['type'] == 'display_reply', '语音呈现协议无效')
    text = value['text']
    require(isinstance(text, str) and 0 < len(text) <= 120 and
            not any(ord(char) < 32 or ord(char) == 127 for char in text), '语音回复文本无效')
    created = value['createdAt']
    require(type(created) in (int, float) and math.isfinite(created), '语音呈现时间无效')
    current = time.time() if now is None else now
    require(-1 <= current - created <= 10, '语音呈现事件已过期或来自未来')
    return text


class SpeechPresentationServer(QObject):
    """A separate, text-only channel; it cannot control pet lifecycle or preferences."""

    def __init__(self, controller, directory, parent=None):
        super().__init__(parent)
        self.controller = controller
        root = Path(directory).expanduser().absolute()
        info = root.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and
                stat.S_IMODE(info.st_mode) == 0o700, '呈现目录必须为本用户私有目录')
        self.path = root / SPEECH_SOCKET_NAME
        require(len(os.fsencode(self.path)) < 104, '语音呈现socket路径过长')
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid(),
                    '语音呈现路径不是本用户socket，拒绝覆盖')
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(.15)
                try:
                    probe.connect(str(self.path))
                except ConnectionRefusedError:
                    require(QLocalServer.removeServer(str(self.path)), '无法移除过期呈现socket')
                else:
                    raise InstanceError('语音呈现socket仍在使用')
        require(self.server.listen(str(self.path)), '无法监听语音呈现socket：' + self.server.errorString())
        os.chmod(self.path, 0o600)
        self.server.newConnection.connect(self._accept)

    def _accept(self):
        while self.server.hasPendingConnections():
            connection = self.server.nextPendingConnection()
            connection.setReadBufferSize(MAX_SPEECH_EVENT + 2)
            state = {'buffer': bytearray(), 'handled': False}
            connection.readyRead.connect(lambda c=connection, s=state: self._read(c, s))
            connection.disconnected.connect(connection.deleteLater)
            timer = QTimer(connection); timer.setSingleShot(True); timer.start(TIMEOUT_MS)
            timer.timeout.connect(connection.abort)
            if connection.bytesAvailable(): self._read(connection, state)

    def _read(self, connection, state):
        if state['handled']:
            return
        state['buffer'].extend(bytes(connection.readAll()))
        if len(state['buffer']) > MAX_SPEECH_EVENT + 1:
            self._reply(connection, state, False, 'event_too_large')
            return
        if b'\n' not in state['buffer']:
            return
        line, extra = bytes(state['buffer']).split(b'\n', 1)
        try:
            require(not extra, '每连接仅允许一个呈现事件')
            text = validate_speech_event(line)
            accepted = self.controller.display_speech_reply(text)
            self._reply(connection, state, accepted, None if accepted else 'pet_busy')
        except (InstanceError, ValueError, TypeError, RecursionError):
            self._reply(connection, state, False, 'invalid_event')

    def _reply(self, connection, state, accepted, reason):
        state['handled'] = True
        response = json.dumps({'ok': accepted, 'reason': reason}, separators=(',', ':')).encode() + b'\n'
        connection.write(response); connection.flush(); connection.disconnectFromServer()

    def close(self):
        self.server.close()
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid():
            self.server.removeServer(str(self.path))


def endpoint(directory):
    root = Path(directory).expanduser().absolute()
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            '控制目录必须为当前用户私有目录（权限0700），不能为链接')
    path = root / SOCKET_NAME
    require(len(os.fsencode(path)) < 104, '控制通道路径过长；请选择较短的私有目录')
    return path


def json_object(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'JSON含重复键')
            result[key] = value
        return result
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(InstanceError('非法JSON数值')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise InstanceError('请求不是有效UTF-8 JSON') from error


def validate_request(request):
    require(isinstance(request, dict), '请求必须为对象')
    require(type(request.get('protocolVersion')) is int and request['protocolVersion'] == PROTOCOL, '不支持的协议版本')
    rid = request.get('requestId')
    require(isinstance(rid, str) and REQUEST_ID.fullmatch(rid), 'requestId无效')
    command = request.get('command')
    require(isinstance(command, str) and command in COMMAND_FIELDS, '未知控制命令')
    require(set(request) == {'protocolVersion', 'requestId', 'command'} | COMMAND_FIELDS[command], '缺少或包含未知请求字段')
    if 'instanceID' in request:
        value = request['instanceID']
        require(isinstance(value, str) and len(value) <= 64 and ID.fullmatch(value), '实例ID无效')
    if 'cloneID' in request:
        value = request['cloneID']
        require(isinstance(value, str) and len(value) <= 64 and ID.fullmatch(value), '小分身ID无效')
        require(value != request.get('instanceID'), '小分身ID不能与源实例相同')
    if 'instanceIDs' in request:
        values = request['instanceIDs']
        require(isinstance(values, list) and 1 <= len(values) <= MAX_BATCH, '批量数量需为1–32')
        require(all(isinstance(v, str) and len(v) <= 64 and ID.fullmatch(v) for v in values), '批量实例ID无效')
        require(len(set(values)) == len(values), '批量实例ID重复')
    if 'preferences' in request:
        value = request['preferences']
        require(isinstance(value, dict) and not set(value) - set(DEFAULT_PREFERENCES) - {'x', 'y'}, '未知实例偏好字段')
        # 用已有另一坐标补齐做类型/范围预检；实际合并与配对在控制器内验证。
        probe = dict(value)
        if 'x' in probe and 'y' not in probe: probe['y'] = 0
        if 'y' in probe and 'x' not in probe: probe['x'] = 0
        preferences(probe)
    if 'packages' in request:
        packages = request['packages']
        require(isinstance(packages, list) and 1 <= len(packages) <= 16, '一次添加需为1–16只桌宠')
        probe = [dict(id='probe-' + str(i), package=p, preferences={}) for i, p in enumerate(packages)]
        validate_registry(dict(schemaVersion=1, instances=probe))
        require(len({(p['id'], p['version']) for p in packages}) == len(packages), '桌宠列表重复')
    if 'package' in request:
        value = request['package']
        require(isinstance(value, dict) and set(value) == {'id', 'version'}, '素材包引用无效')
        require(isinstance(value['id'], str) and re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', value['id']), '包ID无效')
        require(isinstance(value['version'], str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?', value['version']), '包版本无效')
    return request


def validate_reply(reply, request_id):
    require(isinstance(reply, dict) and type(reply.get('protocolVersion')) is int and reply['protocolVersion'] == PROTOCOL
            and reply.get('requestId') == request_id and type(reply.get('ok')) is bool, '响应关联或版本无效')
    if not reply['ok']:
        error = reply.get('error')
        require('result' not in reply and isinstance(error, dict) and isinstance(error.get('code'), str)
                and 1 <= len(error['code']) <= 64 and isinstance(error.get('message'), str) and len(error['message']) <= 512,
                '错误响应无效')
        return reply
    result = reply.get('result')
    require('error' not in reply and isinstance(result, dict), '响应结果无效')
    pid, status = result.get('controllerPID'), result.get('status')
    require(type(pid) is int and 0 < pid <= 2**31 - 1 and isinstance(status, dict), '控制器状态无效')
    require(type(status.get('shuttingDown')) is bool and type(status.get('maximumRunning')) is int
            and 1 <= status['maximumRunning'] <= 8, '控制器状态参数无效')
    rows = status.get('instances')
    require(isinstance(rows, list) and len(rows) <= 32 and all(isinstance(row, dict) for row in rows), '实例状态数量无效')
    validate_registry(dict(schemaVersion=1, instances=[{k: row[k] for k in ('id', 'package', 'displayName', 'enabled', 'autoStartOnLaunch', 'preferences') if k in row} for row in rows]))
    for row in rows:
        require(row.get('phase') in ('stopped', 'starting', 'running', 'stopping', 'failed'), '未知实例阶段')
        require(row.get('error') is None or (isinstance(row['error'], str) and len(row['error']) <= 512), '实例错误信息超限')
    outcomes = result.get('outcomes')
    require(isinstance(outcomes, list) and len(outcomes) <= 32, '批量结果无效')
    identifiers = {row['id'] for row in rows}
    for outcome in outcomes:
        require(isinstance(outcome, dict) and isinstance(outcome.get('instanceID'), str) and outcome['instanceID'] in identifiers
                and type(outcome.get('accepted')) is bool and type(outcome.get('changed')) is bool, '批量实例结果无效')
        require(outcome.get('error') is None or (isinstance(outcome['error'], str) and len(outcome['error']) <= 512), '批量错误信息超限')
    return reply


def dispatch(controller, request):
    """批量先做整体准入校验；窗口工厂的执行失败按实例报告，不强退已运行的其他宠物。"""
    validate_request(request)
    command = request['command']
    outcomes = []
    if command == 'add_pets':
        library = os.environ.get('BAILONG_PET_LIBRARY_DIR')
        require(bool(library), '本地桌宠目录未配置')
        outcomes = controller.register_packages(request['packages'], library)
    elif command == 'start_selected':
        identifiers = request['instanceIDs']
        require(not controller.shutting_down and not controller.starting_factory, '控制器正在退出或忙')
        for identifier in identifiers:
            require(identifier in controller.definitions, '实例不存在：' + identifier)
            require(controller.definitions[identifier]['enabled'], '实例已禁用：' + identifier)
            require(identifier not in controller.sessions or controller.sessions[identifier].phase != 'stopping', '实例仍在清理：' + identifier)
        needed = sum(identifier not in controller.sessions for identifier in identifiers)
        require(len(controller.sessions) + needed <= controller.maximum_running, '批量启动超过同时运行上限')
        controller.set_auto_start(identifiers, True)
        for identifier in identifiers:
            try:
                changed = controller.start(identifier)
                outcomes.append(dict(instanceID=identifier, accepted=True, changed=changed))
            except Exception as error:
                outcomes.append(dict(instanceID=identifier, accepted=False, changed=False, error=str(error)[:512]))
    elif command in ('start_pet', 'stop_pet'):
        identifier = request['instanceID']
        if command == 'start_pet':
            controller.validate_start(identifier)
            controller.set_auto_start([identifier], True)
            changed = controller.start(identifier)
        else:
            controller.set_auto_start([identifier], False)
            changed = controller.stop(identifier)
        outcomes.append(dict(instanceID=request['instanceID'], accepted=True, changed=changed))
    elif command == 'stop_all':
        controller.stop_all()
    elif command == 'delete_pet':
        controller.delete(request['instanceID'])
    elif command == 'set_preferences':
        controller.set_preferences(request['instanceID'], request['preferences'])
    elif command == 'set_package':
        library = os.environ.get('BAILONG_PET_LIBRARY_DIR')
        require(bool(library), '素材库路径未配置')
        controller.set_package(request['instanceID'], request['package'], library)
    elif command == 'clone_pet':
        source = controller.definitions.get(request['instanceID'])
        require(source is not None, '实例不存在：' + request['instanceID'])
        require(request['cloneID'] not in controller.definitions, '小分身ID已存在：' + request['cloneID'])
        require(len(controller.registry['instances']) < 32, '实例数量已达上限')
        clone_preferences = copy.deepcopy(source['preferences'])
        if 'x' in clone_preferences and 'y' in clone_preferences:
            clone_preferences['x'] += 64
            clone_preferences['y'] += 64
        else:
            from PySide6.QtWidgets import QApplication
            screen = QApplication.primaryScreen()
            area = screen.availableGeometry() if screen else None
            clone_preferences['x'] = area.x() + 32 if area else 32
            clone_preferences['y'] = area.y() + 32 if area else 32
        controller.register(dict(id=request['cloneID'], package=copy.deepcopy(source['package']),
                                 enabled=source['enabled'], autoStartOnLaunch=False, preferences=clone_preferences,
                                 **({'displayName': source['displayName'][:77] + '·分身'} if 'displayName' in source else {})))
        outcomes.append(dict(instanceID=request['cloneID'], accepted=True, changed=True))
    elif command == 'shutdown':
        controller.shutdown()
    return dict(controllerPID=os.getpid(), status=controller.status(), outcomes=outcomes)


class InstanceCommandServer(QObject):
    finished = Signal()

    def __init__(self, controller, parent=None):
        super().__init__(parent)
        require(not controller.store.closed, '控制器已关闭')
        self.controller = controller
        self.path = endpoint(controller.store.directory)
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        self.server.setMaxPendingConnections(MAX_CONNECTIONS)
        self.connections = {}
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.draining = self.finished_emitted = False
        # InstanceStore已持有目录锁；只清除本用户的失效socket，不删除普通文件/链接/活通道。
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid(), '已有控制路径不是本用户socket，拒绝覆盖')
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(.15)
                try:
                    probe.connect(str(self.path))
                except ConnectionRefusedError:
                    require(QLocalServer.removeServer(str(self.path)), '无法清理失效控制通道')
                else:
                    raise InstanceError('已有控制通道仍活跃，拒绝替换')
        require(self.server.listen(str(self.path)), '监听失败：' + self.server.errorString())
        try:
            os.chmod(self.path, 0o600)
        except BaseException:
            self.server.close()
            raise
        self.server.newConnection.connect(self._accept)
        self.controller.shutdown_finished.connect(self._shutdown_ready)

    def _accept(self):
        while self.server.hasPendingConnections():
            connection = self.server.nextPendingConnection()
            if self.draining or len(self.connections) >= MAX_CONNECTIONS:
                connection.abort(); connection.deleteLater(); continue
            connection.setReadBufferSize(MAX_REQUEST + 1)
            timer = QTimer(self); timer.setSingleShot(True)
            state = dict(buffer=bytearray(), handled=False, timer=timer)
            self.connections[connection] = state
            timer.timeout.connect(lambda c=connection: self._drop(c))
            connection.readyRead.connect(lambda c=connection: self._read(c))
            connection.disconnected.connect(lambda c=connection: self._drop(c))
            connection.bytesWritten.connect(lambda _, c=connection: self._flush(c))
            timer.start(TIMEOUT_MS)
            if connection.bytesAvailable(): self._read(connection)

    def _read(self, connection):
        state = self.connections.get(connection)
        if not state or state['handled']: return
        state['buffer'].extend(bytes(connection.readAll()))
        data = bytes(state['buffer'])
        if len(data) > MAX_REQUEST:
            self._reply(connection, None, error=('invalid_request', '请求超过8192字节'))
            return
        if b'\n' not in data: return
        line, extra = data.split(b'\n', 1)
        request = None
        try:
            require(not extra, '每连接仅允许一个JSON请求')
            request = validate_request(json_object(line))
            fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).digest()
            cached = self.cache.get(request['requestId'])
            if cached:
                require(cached[0] == fingerprint, '同一requestId不得用于不同命令')
                self.cache.move_to_end(request['requestId'])
                self._send(connection, cached[1]); return
            try:
                result = dispatch(self.controller, request)
            except Exception as error:
                response = self._encoded(request, error=('execution_failed', str(error)[:512]))
            else:
                response = self._encoded(request, result=result)
            self.cache[request['requestId']] = (fingerprint, response)
            self.cache_bytes += len(response)
            while len(self.cache) > 64 or self.cache_bytes > 2 * 1024**2:
                _, (_, removed) = self.cache.popitem(last=False)
                self.cache_bytes -= len(removed)
            self._send(connection, response)
        except (InstanceError, ValueError, TypeError) as error:
            self._reply(connection, request, error=('invalid_request', str(error)[:512]))

    def _encoded(self, request, result=None, error=None):
        rid = request.get('requestId') if isinstance(request, dict) else None
        if not isinstance(rid, str) or not REQUEST_ID.fullmatch(rid): rid = None
        response = dict(protocolVersion=PROTOCOL, requestId=rid, ok=error is None)
        if error: response['error'] = dict(code=error[0], message=error[1])
        else: response['result'] = result
        data = json.dumps(response, ensure_ascii=False, allow_nan=False).encode() + b'\n'
        if len(data) > MAX_RESPONSE:
            return self._encoded(request, error=('response_too_large', '响应超限；请勿自动重放已发送命令'))
        return data

    def _reply(self, connection, request, result=None, error=None):
        self._send(connection, self._encoded(request, result, error))

    def _send(self, connection, data):
        state = self.connections.get(connection)
        if not state: return
        state['handled'] = True; state['buffer'].clear()
        state['timer'].start(TIMEOUT_MS)
        if connection.write(data) != len(data):
            self._drop(connection); return
        connection.flush(); self._flush(connection)

    def _flush(self, connection):
        state = self.connections.get(connection)
        if state and state['handled'] and connection.bytesToWrite() == 0:
            connection.disconnectFromServer()

    def _drop(self, connection):
        state = self.connections.pop(connection, None)
        if state:
            state['timer'].stop(); state['timer'].deleteLater()
            connection.abort(); connection.deleteLater()
        self._finish()

    def _shutdown_ready(self):
        self.draining = True
        self.server.close()  # 已接收连接继续排空，不能让同步shutdown吞掉它自己的ACK。
        self._finish()

    def _finish(self):
        if self.draining and not self.connections and not self.finished_emitted:
            self.finished_emitted = True; self.finished.emit()

    def close(self):
        """测试/所有者销毁通道；不暗中停止宠物，也不释放控制器锁。"""
        self.server.close()
        for connection in list(self.connections): self._drop(connection)


def send_command(directory, command, *, timeout=2.0, request_id=None, **fields):
    """只连接已有控制器，不冷启动、不重试。已发送但未确认时明确返回不确定。"""
    require(type(timeout) in (int, float) and .05 <= timeout <= 10, '超时范围需为0.05–10秒')
    request = validate_request(dict(protocolVersion=PROTOCOL, requestId=request_id or uuid.uuid4().hex, command=command, **fields))
    payload = json.dumps(request, ensure_ascii=False, allow_nan=False).encode() + b'\n'
    require(len(payload) <= MAX_REQUEST, '请求超过大小限制')
    path = endpoint(directory)
    info = path.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, '控制通道类型、所有者或权限无效')
    sent = False
    try:
        import time
        end = time.monotonic() + timeout
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(timeout); connection.connect(str(path))
            # sendall失败也可能已部分发送，必须保守按“不确定”处理。
            remaining = end - time.monotonic()
            if remaining <= 0: raise TimeoutError('发送前已超时')
            connection.settimeout(remaining)
            sent = True; connection.sendall(payload)
            data = bytearray()
            while b'\n' not in data:
                remaining = end - time.monotonic()
                if remaining <= 0: raise TimeoutError('确认超时')
                connection.settimeout(remaining)
                chunk = connection.recv(min(4096, MAX_RESPONSE + 1 - len(data)))
                if not chunk: raise ConnectionError('确认前断开')
                data.extend(chunk)
                if len(data) > MAX_RESPONSE: raise InstanceError('响应超过限制')
            line, extra = bytes(data).split(b'\n', 1)
            require(not extra, '响应含额外数据')
            reply = json_object(line)
            return validate_reply(reply, request['requestId'])
    except (OSError, ValueError, TypeError) as error:
        if sent:
            raise InstanceError('命令已发送但结果不确定；不会自动重放或启动第二个控制器：' + str(error)) from error
        raise
