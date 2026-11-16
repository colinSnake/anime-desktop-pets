#!/usr/bin/env python3
"""日常 AI 气泡的纯 Python 离线回归；仅连接临时目录内的合成 UNIX socket。"""
import ast
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
from pet_ai_bubbles import PetAIBubbleClient, MAX_REPLY_BYTES, MAX_SETTINGS_BYTES

LOCAL = '固定本地文案（不得发送）'
GENERATED = '我在这里陪着你，慢慢来就好。'


def wait_for(predicate, seconds=2):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError('offline worker timeout')
        time.sleep(.002)


class BubbleTests(unittest.TestCase):
    def setUp(self):
        # Short path stays below macOS sockaddr_un.sun_path's 104-byte limit.
        self.tmp = tempfile.TemporaryDirectory(prefix='ai-bubble-', dir='/tmp')
        self.root = Path(self.tmp.name)
        self.now = 1000.
        self.clients = []
        self.servers = []
        self.threads = []
        self.release = threading.Event()
        self.received = []
        self.consent = str(uuid.uuid4())
        self.enabled = True

    def tearDown(self):
        self.release.set()
        for client in self.clients:
            client.close()
        for server in self.servers:
            server.close()
        for thread in self.threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.tmp.cleanup()

    def settings(self, enabled=True):
        if enabled != self.enabled:
            self.consent = str(uuid.uuid4())
        self.enabled = enabled
        (self.root / 'speech-settings.json').write_text(json.dumps(
            {'aiBubblesEnabled': enabled, 'aiBubblesConsentID': self.consent}))

    def client(self, **kwargs):
        client = PetAIBubbleClient(self.root, clock=lambda: self.now, **kwargs)
        self.clients.append(client)
        return client

    def serve(self, reply=None, *, delayed=False, raw=None, fragments=False):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.settimeout(2)
        server.bind(str(self.root / 'control.sock'))
        server.listen(1)
        self.servers.append(server)
        def run():
            connection, _ = server.accept()
            with connection:
                connection.settimeout(2)
                data = bytearray()
                while b'\n' not in data:
                    chunk = connection.recv(1024)
                    if not chunk:
                        return
                    data.extend(chunk)
                self.received.append(json.loads(data.split(b'\n', 1)[0]))
                if delayed:
                    self.release.wait(2)
                response = raw if raw is not None else json.dumps(
                    reply if reply is not None else {'ok': True, 'message': GENERATED, 'phase': 'idle'},
                    ensure_ascii=False).encode() + b'\n'
                try:
                    if fragments:
                        for value in response:
                            connection.sendall(bytes([value]))
                    else:
                        connection.sendall(response)
                except OSError:
                    pass  # A bounded close/timeout deliberately disconnects the fake server.
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.threads.append(thread)

    def ready(self, client):
        wait_for(lambda: not client._pending)

    def prefetch(self, **server_args):
        self.settings()
        self.serve(**server_args)
        client = self.client()
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.ready(client)
        return client

    def test_missing_settings_never_opens_socket_or_starts_worker(self):
        client = self.client()
        with patch('pet_ai_bubbles.socket.socket', side_effect=AssertionError('socket while off')):
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertIsNone(client._worker)

    def test_no_profile_does_not_use_cwd_settings(self):
        self.settings()
        with patch.dict(os.environ, {'BAILONG_DATA_DIR': ''}), patch('os.getcwd', return_value=str(self.root)):
            client = PetAIBubbleClient()
            self.clients.append(client)
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
            self.assertIsNone(client._worker)

    def test_profile_uses_shared_environment_not_pet_instance(self):
        with patch.dict(os.environ, {'BAILONG_DATA_DIR': str(self.root)}):
            client = PetAIBubbleClient()
            self.clients.append(client)
            self.assertEqual(client.directory, self.root)
            self.assertEqual(client.timeout, 10.)

    def test_invalid_settings_fail_closed(self):
        path = self.root / 'speech-settings.json'
        for value in ('{}', '[]', '{bad', 'null', '{"aiBubblesEnabled":1}',
                      '{"aiBubblesEnabled":"true"}', '{"aiBubblesEnabled":false}',
                      ' ' * (MAX_SETTINGS_BYTES + 1)):
            with self.subTest(value=value[:70]):
                path.write_text(value)
                client = self.client()
                self.assertEqual(client.choose('idle', LOCAL), LOCAL)
                self.assertIsNone(client._worker)

    def test_missing_or_invalid_consent_id_fails_closed(self):
        for consent in (None, '', 1, True, {}, 'not-a-uuid'):
            with self.subTest(consent=consent):
                (self.root / 'speech-settings.json').write_text(json.dumps(
                    {'aiBubblesEnabled': True, 'aiBubblesConsentID': consent}))
                client = self.client()
                self.assertEqual(client.choose('idle', LOCAL), LOCAL)
                self.assertIsNone(client._worker)

    def test_same_consent_preserves_cache_on_unrelated_settings_save(self):
        client = self.prefetch()
        (self.root / 'speech-settings.json').write_text(json.dumps(
            {'aiBubblesEnabled': True, 'aiBubblesConsentID': self.consent,
             'speakInteractiveBubbles': False}))
        self.assertEqual(client.choose('idle', LOCAL), GENERATED)

    def test_rotated_consent_discards_cache_even_while_enabled(self):
        client = self.prefetch()
        self.consent = str(uuid.uuid4())
        self.settings()
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_rotated_consent_discards_inflight_even_while_enabled(self):
        self.settings()
        self.serve(delayed=True)
        client = self.client()
        client.choose('idle', LOCAL)
        wait_for(lambda: self.received)
        self.consent = str(uuid.uuid4())
        self.settings()
        self.release.set()
        self.ready(client)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_nonregular_or_symlink_settings_fail_closed_without_blocking(self):
        self.settings()
        path = self.root / 'speech-settings.json'
        path.rename(self.root / 'real-settings')
        for make in (lambda: path.symlink_to(self.root / 'real-settings'),
                     lambda: os.mkfifo(path), lambda: path.mkdir()):
            make()
            client = self.client()
            start = time.monotonic()
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
            self.assertLess(time.monotonic() - start, .1)
            self.assertIsNone(client._worker)
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()

    def test_whitelist_payload_and_single_consumption_without_fallback_context(self):
        client = self.prefetch(fragments=True)
        self.assertEqual(self.received, [{'command': 'bubble', 'event': 'idle'}])
        self.assertEqual(client.choose('idle', LOCAL), GENERATED)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_enum_events_are_separate_and_invalid_events_never_queue(self):
        self.settings()
        client = self.client()
        for event in ('task', 'say', '', None, {'event': 'idle'}, ['idle']):
            self.assertEqual(client.choose(event, LOCAL), LOCAL)
        self.assertIsNone(client._worker)
        self.serve()
        self.assertEqual(client.choose('interaction', LOCAL), LOCAL)
        self.ready(client)
        self.assertEqual(client.choose('reminder', LOCAL), LOCAL)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertEqual(client.choose('interaction', LOCAL), GENERATED)
        self.assertEqual(self.received, [{'command': 'bubble', 'event': 'interaction'}])

    def test_reminder_payload_is_enum_only(self):
        self.settings()
        self.serve()
        client = self.client()
        self.assertEqual(client.choose('reminder', LOCAL), LOCAL)
        self.ready(client)
        self.assertEqual(self.received, [{'command': 'bubble', 'event': 'reminder'}])
        self.assertEqual(client.choose('reminder', LOCAL), GENERATED)

    def test_slow_host_is_nonblocking_queue_is_one_and_worker_is_daemon(self):
        self.settings()
        self.serve(delayed=True)
        client = self.client()
        start = time.monotonic()
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertLess(time.monotonic() - start, .1)
        wait_for(lambda: self.received)
        self.assertTrue(client._worker.daemon)
        self.assertEqual(client._queue.maxsize, 1)
        self.now += 601
        start = time.monotonic()
        for _ in range(100):
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertLess(time.monotonic() - start, .2)
        self.assertEqual(client._queue.qsize(), 0)
        self.assertEqual(len(self.received), 1)
        self.release.set()
        self.ready(client)
        # A reply is only cached; worker has no presentation/Qt callback.
        self.assertEqual(client.choose('idle', LOCAL), GENERATED)

    def test_worker_start_failure_stays_local_and_counts_attempt(self):
        self.settings()
        client = self.client()
        with patch('pet_ai_bubbles.threading.Thread.start', side_effect=RuntimeError('no threads')) as start:
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
            self.assertEqual(start.call_count, 1)
        self.assertIsNone(client._worker)
        self.assertFalse(client._pending)
        self.assertEqual(client._queue.qsize(), 0)
        client.close()

    def test_cooldown_counts_failures_and_spans_event_types(self):
        self.settings()
        client = self.client(timeout=.03)
        client.choose('idle', LOCAL)  # Missing host consumes this local attempt.
        self.ready(client)
        self.now += 599.99
        self.serve()
        self.assertEqual(client.choose('interaction', LOCAL), LOCAL)
        self.assertEqual(self.received, [])
        self.now += .01
        self.assertEqual(client.choose('interaction', LOCAL), LOCAL)
        self.ready(client)
        self.assertEqual(self.received, [{'command': 'bubble', 'event': 'interaction'}])

    def test_invalid_replies_are_not_cached(self):
        replies = [None, [], {'ok': False, 'message': GENERATED}, {'message': GENERATED},
                   {'ok': 1, 'message': GENERATED}, {'ok': True, 'text': GENERATED},
                   {'ok': True, 'message': 5}]
        unsafe = ['', ' ', '字' * 61, 'hi\nthere', '\x00bad', 'bad\x7f', 'hidden\u202e',
                  '\ud800', '段\u2028落', '完成啦！', '任务已经完成', 'All tasks completed.',
                  'https://example.com', '<tool_call>exec</tool_call>', '{"tool":"exec"}',
                  '```run```']
        replies += [{'ok': True, 'message': value} for value in unsafe]
        for reply in replies:
            with self.subTest(reply=repr(reply)):
                with patch.object(PetAIBubbleClient, '_request', return_value=reply):
                    self.settings()
                    client = self.client()
                    client.choose('idle', LOCAL)
                    self.ready(client)
                    self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_malformed_and_oversized_wire_replies_fail_closed(self):
        for raw in (b'broken\n', b'{"ok":true,\xff}\n', b' ' * (MAX_REPLY_BYTES + 1),
                    b'{"ok": true, "message": "missing newline"}'):
            with self.subTest(raw=raw[:40]):
                client = self.prefetch(raw=raw)
                self.assertEqual(client.choose('idle', LOCAL), LOCAL)
                (self.root / 'control.sock').unlink()

    def test_sixty_character_plain_text_is_allowed(self):
        client = self.prefetch(reply={'ok': True, 'message': '好' * 60})
        self.assertEqual(client.choose('idle', LOCAL), '好' * 60)

    def test_disabled_discards_cache_before_consumption_and_reenable_cannot_restore_it(self):
        client = self.prefetch()
        self.settings(False)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.settings(True)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertEqual(len(self.received), 1)

    def test_inflight_response_checks_settings_even_without_another_gui_event(self):
        self.settings()
        self.serve(delayed=True)
        client = self.client()
        client.choose('idle', LOCAL)
        wait_for(lambda: self.received)
        self.settings(False)
        self.release.set()
        self.ready(client)
        self.settings(True)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_revocation_generation_rejects_late_response_after_reenabled(self):
        self.settings()
        self.serve(delayed=True)
        client = self.client()
        client.choose('idle', LOCAL)
        wait_for(lambda: self.received)
        self.settings(False)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.settings(True)
        client.choose('idle', LOCAL)
        self.release.set()
        self.ready(client)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_settings_rewrite_detects_unobserved_disable_then_enable(self):
        self.settings()
        self.serve(delayed=True)
        client = self.client()
        client.choose('idle', LOCAL)
        wait_for(lambda: self.received)
        self.settings(False)
        self.settings(True)
        self.release.set()
        self.ready(client)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_worker_rechecks_authorization_before_socket(self):
        self.settings()
        client = self.client()
        # Pause queue pickup, revoke after choose, then let the real worker continue.
        original = client._queue.get
        entered = threading.Event()
        def delayed_get(*args, **kwargs):
            entered.set()
            self.release.wait(2)
            return original(*args, **kwargs)
        with patch.object(client._queue, 'get', side_effect=delayed_get), \
             patch.object(client, '_request', side_effect=AssertionError('request after revocation')) as request:
            client.choose('idle', LOCAL)
            self.assertTrue(entered.wait(1))
            self.settings(False)
            self.release.set()
            self.ready(client)
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
            request.assert_not_called()

    def test_cache_ttl_is_thirty_minutes(self):
        client = self.prefetch()
        with patch.object(client, '_request', return_value=None):
            self.now += 1800
            self.assertEqual(client.choose('idle', LOCAL), LOCAL)
            self.ready(client)

    def test_cache_is_valid_just_before_ttl(self):
        client = self.prefetch()
        with patch.object(client, '_request', return_value=None):
            self.now += 1799.99
            self.assertEqual(client.choose('idle', LOCAL), GENERATED)
            self.ready(client)

    def test_consumption_validates_cached_text_again(self):
        client = self.prefetch()
        cached = client._cache['idle']
        client._cache['idle'] = (cached[0], cached[1], 'bad\x00')
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)

    def test_timeout_is_bounded_and_does_not_retry(self):
        self.settings()
        self.serve(delayed=True)
        client = self.client(timeout=.04)
        start = time.monotonic()
        client.choose('idle', LOCAL)
        self.ready(client)
        self.assertLess(time.monotonic() - start, .5)
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertEqual(len(self.received), 1)

    def test_close_is_bounded_idempotent_and_discards_inflight_reply(self):
        self.settings()
        self.serve(delayed=True)
        client = self.client()
        client.choose('idle', LOCAL)
        wait_for(lambda: self.received)
        start = time.monotonic()
        client.close()
        client.close()
        self.assertLess(time.monotonic() - start, .2)
        self.release.set()
        client._worker.join(1)
        self.assertFalse(client._worker.is_alive())
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertEqual(client._cache, {})

    def test_close_without_worker_or_with_cached_reply(self):
        client = self.client()
        client.close()
        self.settings()
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)
        self.assertIsNone(client._worker)
        client = self.prefetch()
        client.close()
        self.assertEqual(client.choose('idle', LOCAL), LOCAL)


class WiringTests(unittest.TestCase):
    """Execute actual behavior methods with plain doubles: Qt is not imported."""
    def behavior(self):
        source = ast.parse((ROOT / 'apps/pet-runtime/bailong/dragon_behavior.py').read_text())
        cls = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'AutonomousBehavior')
        # Class declarations and these scheduling methods have no Qt dependency.
        methods = {'tick', '_perform_action_unchecked', '_perform_action', '_choose_idle_line'}
        cls.body = [node for node in cls.body if isinstance(node, ast.Assign) or
                    isinstance(node, ast.FunctionDef) and node.name in methods]
        namespace = {}
        exec(compile(ast.Module(body=[cls], type_ignores=[]), '<behavior-scheduling>', 'exec'), namespace)
        behavior = namespace['AutonomousBehavior']()
        pet = SimpleNamespace(ai_bubbles=SimpleNamespace(choose=Mock(return_value=GENERATED)),
                              current={'id': 'before'}, say=Mock(), dragging=False, waiting_first_frame=False)
        behavior.pet = pet
        behavior.next_action = Mock(return_value={'id': '01', 'line': '主人来啦！今天也一起把小事做好吧。'})
        behavior._play = Mock()
        return behavior

    def test_scheduled_generic_line_uses_idle_and_same_final_say(self):
        behavior = self.behavior()
        self.assertTrue(behavior._perform_action())
        behavior.pet.ai_bubbles.choose.assert_called_once_with('idle', '主人来啦！今天也一起把小事做好吧。')
        behavior.pet.say.assert_called_once_with(GENERATED, ms=4000)

    def test_preview_and_exact_action_caption_do_not_call_ai(self):
        behavior = self.behavior()
        behavior._perform_action(preview=True)
        behavior.pet.ai_bubbles.choose.assert_not_called()
        behavior.pet.say.assert_not_called()
        for line in ('完成啦！给主人和我各贴一颗小星星！', '呼——这是小龙吐息！', '未审核的任意素材台词'):
            behavior.next_action.return_value = {'id': '18', 'line': line}
            behavior._perform_action()
            behavior.pet.ai_bubbles.choose.assert_not_called()
            behavior.pet.say.assert_called_with(line, ms=4000)

    def test_idle_greeting_routes_to_idle_choose_before_say(self):
        behavior = self.behavior()
        behavior.closed = False
        behavior.clock = lambda: 1000.
        behavior.motion = None
        behavior.held_release_animation = False
        behavior.next_greeting_at = 0.
        behavior.has_longmei_greeting_copy = lambda: True
        behavior.blocked = lambda: False
        behavior.motion_reduced = lambda: False
        behavior.last_greeting = None
        behavior.rng = SimpleNamespace(choice=lambda values: values[0], uniform=lambda *args: 180.)
        behavior.tick()
        behavior.pet.ai_bubbles.choose.assert_called_once_with('idle', behavior.IDLE_GREETINGS[0])
        behavior.pet.say.assert_called_once_with(GENERATED, ms=4500)

    def test_patch_uses_shared_profile_and_closes_client(self):
        text = (ROOT / 'integrations/bailong/pet.py.patch').read_text()
        self.assertIn('+from pet_ai_bubbles import PetAIBubbleClient', text)
        self.assertIn('+        self.ai_bubbles=PetAIBubbleClient()', text)
        self.assertIn('+        self.ai_bubbles.close()', text)

    def test_frozen_copy_hidden_import_and_fingerprint_include_module(self):
        for filename in ('scripts/build-pet-runtime.py', 'scripts/pet-build-inputs.py'):
            text = (ROOT / filename).read_text()
            self.assertIn("'pet_ai_bubbles.py'", text)
            self.assertIn("'pet_ai_bubbles'", text)
        spec = importlib.util.spec_from_file_location('inputs', ROOT / 'scripts/pet-build-inputs.py')
        inputs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(inputs)
        self.assertIn('apps/pet-runtime/bailong/pet_ai_bubbles.py', inputs.fingerprints())
        with self.assertRaisesRegex(ValueError, 'pet_ai_bubbles'):
            inputs.check_frozen_modules('pet_instances pet_instance_ipc pet_helper pet_reference_lock '
                                        'pet_library pet_sources pet_release_physics dragon_tasks dragon_quota')


if __name__ == '__main__':
    unittest.main(verbosity=2)
