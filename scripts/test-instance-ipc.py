#!/usr/bin/env python3
"""多宠本地控制的离线/真实子进程测试；只用临时profile和合成无界面窗口适配器。"""
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/pets'))
from dragon_instance_ipc import MAX_REQUEST, SOCKET_NAME, InstanceCommandServer, endpoint, send_command, validate_request, validate_reply
from dragon_instances import InstanceController, InstanceError, InstanceStore


def request(command='status', **fields):
    value = dict(protocolVersion=1, requestId=uuid.uuid4().hex, command=command)
    value.update(fields)
    return value


def fixture_server(profile):
    # 禁止把测试入口误当成正常桌宠启动器。
    if os.environ.get('DRAGON_INSTANCE_IPC_FIXTURE') != '1' or os.environ.get('QT_QPA_PLATFORM') != 'offscreen':
        return 2
    from PySide6.QtCore import QObject, QTimer, Signal
    from PySide6.QtWidgets import QApplication
    app = QApplication([])
    class SyntheticWindow(QObject):
        ready = Signal()
        failed = Signal(str)
        stopped = Signal()
        def __init__(self, definition, state):
            super().__init__(); self.stopping = False
            if definition['id'] == 'third': raise ValueError('synthetic factory failure')
        def begin(self):
            QTimer.singleShot(10, lambda: self.ready.emit() if not self.stopping else None)
        def request_stop(self):
            self.stopping = True; self.stopped.emit()
        def apply_preferences(self, value): pass
    store = InstanceStore(profile)
    controller = InstanceController(store, SyntheticWindow, maximum_running=2)
    if not controller.definitions:
        for identifier in ('first', 'second', 'third', 'disabled'):
            controller.register(dict(id=identifier, package=dict(id='local.' + identifier, version='1.0.0'),
                                     enabled=identifier != 'disabled', autoStartOnLaunch=identifier != 'third',
                                     preferences={}))
    server = InstanceCommandServer(controller)
    server.finished.connect(app.quit)
    # 防测试失败遗留进程；不是后台监视器或产品自动退出策略。
    QTimer.singleShot(30000, app.quit)
    try:
        return app.exec()
    finally:
        server.close(); controller.shutdown(); store.close()


def transport_fixture(profile, mode):
    if os.environ.get('DRAGON_INSTANCE_IPC_FIXTURE') != '1': return 2
    path = Path(profile) / SOCKET_NAME
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(path)); path.chmod(0o600); server.listen(1); server.settimeout(5)
        connection, _ = server.accept()
        with connection:
            connection.settimeout(3); payload = b''
            while b'\n' not in payload:
                chunk = connection.recv(8192)
                if not chunk: return 1
                payload += chunk
            (Path(profile) / 'delivery-count').write_text('1')
            if mode == 'wrong-id':
                connection.sendall(b'{"protocolVersion":1,"requestId":"wrong","ok":false,"error":{"code":"x","message":"fixture"}}\n')
            elif mode == 'slow': time.sleep(.3)
            elif mode == 'oversized':
                try: connection.sendall(b'x' * (128 * 1024 + 1))
                except BrokenPipeError: pass
    return 0


class RequestChecks(unittest.TestCase):
    def test_whitelist_and_unknown_fields(self):
        for bad in [request('run_shell'), request(path='/private'), request(protocolVersion=True),
                    request('start_pet', instanceID='../bad'), request('start_pet'), request('status', requestId='bad\n')]:
            with self.subTest(bad=bad):
                with self.assertRaises(InstanceError): validate_request(bad)
        for bad in [request('clone_pet'), request('clone_pet', instanceID='first'),
                    request('clone_pet', instanceID='first', cloneID='first'),
                    request('clone_pet', instanceID='first', cloneID='../copy'),
                    request('set_package'),
                    request('set_package', instanceID='first', package={'id': '../escape', 'version': '1.0.0'}),
                    request('set_package', instanceID='first', package={'id': 'local.test', 'version': 'latest'}),
                    request('set_package', instanceID='first', package={'id': 'local.test', 'version': '1.0.0', 'path': '/tmp'})]:
            with self.assertRaises(InstanceError): validate_request(bad)

    def test_batch_and_preference_limits(self):
        for bad in [request('start_selected', instanceIDs=[]), request('start_selected', instanceIDs=['a'] * 2),
                    request('start_selected', instanceIDs=['p' + str(i) for i in range(33)]),
                    request('set_preferences', instanceID='first', preferences={'size': True}),
                    request('set_preferences', instanceID='first', preferences={'size': 513}),
                    request('set_preferences', instanceID='first', preferences={'script': 'run'})]:
            with self.subTest(bad=bad):
                with self.assertRaises(InstanceError): validate_request(bad)

    def test_unconfirmed_delivery_is_not_retried(self):
        for mode in ('disconnect', 'mismatched', 'oversized', 'slow'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='dpi-', dir='/tmp') as tmp:
                path = Path(tmp) / SOCKET_NAME
                server = socket.socket(socket.AF_UNIX); server.bind(str(path)); server.listen(2); path.chmod(0o600)
                received = []; errors = []
                def serve():
                    try:
                        connection, _ = server.accept()
                        with connection:
                            payload = connection.recv(8192); received.append(payload)
                            if mode == 'mismatched':
                                connection.sendall(b'{"protocolVersion":1,"requestId":"wrong","ok":true,"result":{}}\n')
                            elif mode == 'oversized':
                                try: connection.sendall(b'x' * (128 * 1024 + 1))
                                except BrokenPipeError: pass
                            elif mode == 'slow': time.sleep(.15)
                    except Exception as error: errors.append(error)
                worker = threading.Thread(target=serve); worker.start()
                try:
                    with self.assertRaisesRegex(InstanceError, '不确定.*不会自动重放'):
                        send_command(tmp, 'stop_all', timeout=.05 if mode == 'slow' else 2)
                finally:
                    worker.join(timeout=3); server.close()
                self.assertFalse(worker.is_alive()); self.assertFalse(errors)
                self.assertEqual(len(received), 1)

    def test_response_validation_rejects_missing_status_and_invalid_phases(self):
        valid = dict(protocolVersion=1, requestId='r', ok=True, result=dict(controllerPID=1,
                     status=dict(shuttingDown=False, maximumRunning=2, instances=[]), outcomes=[]))
        self.assertTrue(validate_reply(valid, 'r')['ok'])
        invalid = [dict(protocolVersion=1, requestId='r', ok=True, result={}),
                   dict(protocolVersion=1, requestId='r', ok=False, error={})]
        import copy
        bad = copy.deepcopy(valid); bad['result']['status']['maximumRunning'] = True; invalid.append(bad)
        bad = copy.deepcopy(valid); bad['result']['status']['instances'] = [dict(
            id='first', package=dict(id='local.first', version='1.0.0'), enabled=True, preferences={}, phase='unknown')]; invalid.append(bad)
        for reply in invalid:
            with self.assertRaises(InstanceError): validate_reply(reply, 'r')

    def test_existing_non_socket_path_is_never_removed(self):
        with tempfile.TemporaryDirectory(prefix='dpi-', dir='/tmp') as tmp:
            path = Path(tmp) / SOCKET_NAME; path.write_bytes(b'preserve user file')
            env = dict(os.environ, HOME=tmp, QT_QPA_PLATFORM='offscreen', DRAGON_INSTANCE_IPC_FIXTURE='1')
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--fixture-server', tmp],
                                    env=env, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(path.read_bytes(), b'preserve user file')

    def test_insecure_directory_rejected(self):
        with tempfile.TemporaryDirectory(prefix='dpi-', dir='/tmp') as tmp:
            Path(tmp).chmod(0o755)
            with self.assertRaises(InstanceError): endpoint(tmp)


class IPCChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dpi-', dir='/tmp')
        self.profile = Path(self.temp.name)
        self.env = dict(os.environ, HOME=str(self.profile), BAILONG_DATA_DIR=str(self.profile),
                        QT_QPA_PLATFORM='offscreen', DRAGON_INSTANCE_IPC_FIXTURE='1')
        self.child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--fixture-server', str(self.profile)],
                                      env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.path = self.profile / SOCKET_NAME
        for _ in range(150):
            if self.path.exists(): break
            if self.child.poll() is not None: self.fail(str(self.child.communicate()))
            time.sleep(.01)
        self.assertTrue(self.path.exists(), 'fixture socket未就绪')

    def tearDown(self):
        if self.child.poll() is None:
            try:
                send_command(self.profile, 'shutdown')
                self.child.wait(timeout=3)
            except Exception:
                self.child.terminate(); self.child.wait(timeout=3)
        self.child.communicate()
        self.temp.cleanup()

    def command(self, command='status', **fields):
        reply = send_command(self.profile, command, **fields)
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    def raw(self, payload, fragments=False):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(3); connection.connect(str(self.path))
            if fragments:
                middle = len(payload) // 2
                connection.sendall(payload[:middle]); time.sleep(.025); connection.sendall(payload[middle:])
            else: connection.sendall(payload)
            data = b''
            while b'\n' not in data:
                chunk = connection.recv(4096)
                if not chunk: break
                data += chunk
            return json.loads(data) if data else None

    def states(self):
        return {r['id']: r for r in self.command()['status']['instances']}

    def test_real_process_permissions_status_and_fragmented_json(self):
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        result = self.command()
        self.assertEqual(result['controllerPID'], self.child.pid)
        self.assertTrue(all(row['phase'] == 'stopped' for row in result['status']['instances']))
        reply = self.raw((json.dumps(request(), ensure_ascii=False) + '\n').encode(), fragments=True)
        self.assertTrue(reply['ok'])

    def test_individual_start_resize_and_stop_do_not_affect_other(self):
        self.command('start_selected', instanceIDs=['first', 'second'])
        for _ in range(100):
            if all(self.states()[key]['phase'] == 'running' for key in ('first', 'second')): break
            time.sleep(.01)
        self.command('set_preferences', instanceID='first', preferences={'size': 128, 'x': -400, 'y': 60})
        self.assertEqual(self.states()['first']['preferences']['size'], 128)
        self.assertEqual(self.states()['second']['preferences']['size'], 256)
        self.command('stop_pet', instanceID='first')
        states = self.states()
        self.assertEqual(states['first']['phase'], 'stopped')
        self.assertEqual(states['second']['phase'], 'running')

    def test_cli_clone_uses_real_protocol_and_persists(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/pet-instances.py'),
                                 '--profile', str(self.profile), 'clone', 'first', 'cli-copy'],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(json.loads(result.stdout)['ok'])
        self.assertEqual(self.states()['cli-copy']['phase'], 'stopped')
        rows = json.loads((self.profile / 'pet-instances.json').read_text())['instances']
        self.assertIn('cli-copy', [row['id'] for row in rows])

    def test_clone_shares_package_but_is_stopped_and_preferences_are_independent(self):
        self.command('set_preferences', instanceID='first', preferences={'size': 200, 'x': -120, 'y': 80})
        result = self.command('clone_pet', instanceID='first', cloneID='first-copy')
        states = self.states()
        self.assertIn('first-copy', states)
        self.assertEqual(states['first-copy']['phase'], 'stopped')
        self.assertTrue(states['first-copy']['enabled'])
        self.assertFalse(states['first-copy']['autoStartOnLaunch'])
        self.assertEqual(states['first-copy']['package'], states['first']['package'])
        self.assertEqual(states['first-copy']['preferences']['size'], 200)
        self.assertEqual(states['first-copy']['preferences']['x'], -56)
        self.assertEqual(states['first-copy']['preferences']['y'], 144)
        self.command('start_pet', instanceID='first-copy')
        self.assertTrue(self.states()['first-copy']['autoStartOnLaunch'])
        for _ in range(100):
            if self.states()['first-copy']['phase'] == 'running': break
            time.sleep(.01)
        self.assertEqual(self.states()['first-copy']['phase'], 'running')
        self.command('set_preferences', instanceID='first-copy', preferences={'size': 144})
        states = self.states()
        self.assertEqual(states['first-copy']['preferences']['size'], 144)
        self.assertEqual(states['first']['preferences']['size'], 200)
        self.command('stop_pet', instanceID='first-copy')
        self.assertFalse(self.states()['first-copy']['autoStartOnLaunch'])
        duplicate = send_command(self.profile, 'clone_pet', instanceID='first', cloneID='first-copy')
        self.assertFalse(duplicate['ok'])
        self.assertIn('已存在', duplicate['error']['message'])
        rid = uuid.uuid4().hex
        first = send_command(self.profile, 'clone_pet', request_id=rid, instanceID='first', cloneID='first-copy-2')
        replay = send_command(self.profile, 'clone_pet', request_id=rid, instanceID='first', cloneID='first-copy-2')
        self.assertEqual(replay, first)
        self.assertIn('first-copy-2', self.states())

    def test_delete_requires_stopped_non_original_and_preserves_state_directory(self):
        self.command('start_pet', instanceID='second')
        with self.assertRaises(AssertionError):
            self.command('delete_pet', instanceID='second')
        self.command('stop_pet', instanceID='second')
        self.command('delete_pet', instanceID='second')
        self.assertNotIn('second', self.states())
        self.assertTrue((self.profile / 'instances' / 'second').exists())

    def test_batch_admission_rejects_unknown_disabled_or_over_capacity_before_start(self):
        for identifiers in (['first', 'unknown'], ['first', 'disabled'], ['first', 'second', 'third']):
            reply = send_command(self.profile, 'start_selected', instanceIDs=identifiers)
            self.assertFalse(reply['ok'])
            self.assertTrue(all(row['phase'] == 'stopped' for row in self.states().values()))

    def test_capacity_rejected_start_does_not_enable_auto_restore(self):
        self.command('start_selected', instanceIDs=['first', 'second'])
        reply = send_command(self.profile, 'start_pet', instanceID='third')
        self.assertFalse(reply['ok'])
        self.assertFalse(self.states()['third']['autoStartOnLaunch'])

    def test_batch_factory_failure_reports_partial_result_without_stopping_success(self):
        result = self.command('start_selected', instanceIDs=['first', 'third'])
        outcomes = {r['instanceID']: r for r in result['outcomes']}
        self.assertTrue(outcomes['first']['accepted'])
        self.assertFalse(outcomes['third']['accepted'])
        self.assertIn(self.states()['first']['phase'], ('starting', 'running'))
        self.assertEqual(self.states()['third']['phase'], 'failed')

    def test_saturated_connections_are_bounded_and_recover(self):
        connections = []
        try:
            for _ in range(17):
                connection = socket.socket(socket.AF_UNIX); connection.settimeout(3)
                connection.connect(str(self.path)); connection.sendall(b'{'); connections.append(connection)
            try: self.assertEqual(connections[-1].recv(1), b'')
            except ConnectionResetError: pass
        finally:
            for connection in connections: connection.close()
        time.sleep(.05)
        self.assertTrue(self.command())

    def test_start_and_stop_all_are_not_shutdown(self):
        self.command('start_pet', instanceID='first')
        result = self.command('start_pet', instanceID='first')
        self.assertFalse(result['outcomes'][0]['changed'])
        self.command('stop_all')
        self.assertFalse(self.command()['status']['shuttingDown'])
        self.command('start_pet', instanceID='second')

    def test_retry_same_request_id_does_not_stop_a_restarted_pet(self):
        self.command('start_pet', instanceID='first')
        rid = uuid.uuid4().hex
        original = send_command(self.profile, 'stop_pet', request_id=rid, instanceID='first')
        self.command('start_pet', instanceID='first')
        replay = send_command(self.profile, 'stop_pet', request_id=rid, instanceID='first')
        self.assertEqual(replay, original)
        self.assertIn(self.states()['first']['phase'], ('starting', 'running'))
        conflict = send_command(self.profile, 'start_pet', request_id=rid, instanceID='first')
        self.assertFalse(conflict['ok']); self.assertEqual(conflict['error']['code'], 'invalid_request')

    def test_invalid_messages_have_no_effect_and_server_survives(self):
        values = [b'{"command":"run_shell"}\n', b'\xff\n', b'{"a":1,"a":2}\n',
                  b'{}\n{}\n', b'x' * (MAX_REQUEST + 1)]
        for payload in values:
            with self.subTest(payload=payload[:30]):
                reply = self.raw(payload)
                self.assertFalse(reply['ok'])
                self.assertTrue(all(row['phase'] == 'stopped' for row in self.states().values()))

    def test_empty_disconnect_does_not_reveal_or_start_anything(self):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(str(self.path))
        self.assertTrue(all(row['phase'] == 'stopped' for row in self.states().values()))

    def test_partial_request_deadline_releases_connection(self):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(4); connection.connect(str(self.path)); connection.sendall(b'{')
            self.assertEqual(connection.recv(1), b'')
        self.assertTrue(self.command())

    def test_second_controller_cannot_remove_live_socket(self):
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--fixture-server', str(self.profile)],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.path.exists()); self.assertEqual(self.command()['controllerPID'], self.child.pid)

    def test_shutdown_ack_is_flushed_before_exit_and_socket_cleaned(self):
        self.command('start_selected', instanceIDs=['first', 'second'])
        reply = self.command('shutdown')
        self.assertTrue(reply['status']['shuttingDown'])
        self.child.wait(timeout=3)
        self.assertFalse(self.path.exists())

    def test_cli_json_and_absent_controller_never_cold_starts(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/pet-instances.py'), '--profile', str(self.profile), 'status'],
                                env=self.env, capture_output=True, text=True, timeout=4)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])
        self.command('shutdown'); self.child.wait(timeout=3)
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/pet-instances.py'), '--profile', str(self.profile), 'status'],
                                env=self.env, capture_output=True, text=True, timeout=4)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stderr)['ok']); self.assertFalse(self.path.exists())


class FirstRunBootstrapChecks(unittest.TestCase):
    def test_helper_initializes_missing_profile_and_leaves_copy_stopped(self):
        with tempfile.TemporaryDirectory(prefix='dragon-first-run-', dir='/tmp') as tmp:
            root = Path(tmp); profile = root / 'profile'; profile.mkdir(mode=0o700)
            assets = root / 'assets'; assets.mkdir()
            (assets / '素材清单.json').write_text('{"version":1}', encoding='utf-8')
            (assets / 'idle.webp').write_bytes(b'synthetic webp bytes')
            library = root / 'library'; library.mkdir(mode=0o700)
            preferences = dict(size=210, x=900, y=120, scheduledActivity=False,
                               movement=True, hideInFullscreen=False)
            code = (
                'import sys; from PySide6.QtWidgets import QApplication; QApplication([]); '
                'from dragon_pet_helper import main; '
                'raise SystemExit(main(sys.argv[1:]))'
            )
            env = dict(os.environ, HOME=str(root), QT_QPA_PLATFORM='offscreen',
                       BAILONG_DATA_DIR=str(profile), BAILONG_PET_LIBRARY_DIR=str(library),
                       BAILONG_ASSETS_DIR=str(assets),
                       PYTHONPATH=str(ROOT / 'apps/pet-runtime/pets'))
            child = subprocess.Popen([sys.executable, '-c', code, '--multi-profile', str(profile),
                                      '--initial-from-assets', str(assets), '--initial-preferences',
                                      json.dumps(preferences)], env=env, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
            try:
                socket_path = profile / SOCKET_NAME
                for _ in range(300):
                    if socket_path.exists(): break
                    if child.poll() is not None: self.fail(str(child.communicate()))
                    time.sleep(.01)
                self.assertTrue(socket_path.exists(), 'helper control socket did not become ready')
                result = send_command(profile, 'status')['result']
                rows = {row['id']: row for row in result['status']['instances']}
                self.assertEqual(set(rows), {'white-dragon', 'white-dragon-copy'})
                self.assertEqual(rows['white-dragon']['preferences'], preferences)
                self.assertTrue(rows['white-dragon']['enabled'])
                self.assertTrue(rows['white-dragon-copy']['enabled'])
                self.assertFalse(rows['white-dragon-copy']['autoStartOnLaunch'])
                self.assertEqual(rows['white-dragon-copy']['phase'], 'stopped')
                self.assertNotEqual((rows['white-dragon-copy']['preferences']['x'],
                                     rows['white-dragon-copy']['preferences']['y']),
                                    (preferences['x'], preferences['y']))
                self.assertEqual(rows['white-dragon']['package'], rows['white-dragon-copy']['package'])
                self.assertRegex(rows['white-dragon']['package']['version'], r'^0\.0\.0-[0-9a-f]{24}$')
                send_command(profile, 'shutdown')
                child.wait(timeout=3)
                self.assertEqual(child.returncode, 0, child.communicate())
            finally:
                if child.poll() is None:
                    child.terminate(); child.wait(timeout=3)
                child.communicate()


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--transport-fixture':
        sys.exit(transport_fixture(sys.argv[2], sys.argv[3]))
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture-server':
        sys.exit(fixture_server(sys.argv[2]))
    unittest.main(verbosity=2)
