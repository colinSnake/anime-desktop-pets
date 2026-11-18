"""Portable protocol tests: no Qt imports, real assets, or user profiles."""
import io
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from player_protocol import parse_bootstrap, parse_request, position_event, read_frame, reply

SESSION = 'a' * 64
ID = 'b' * 32


def frame(**extra):
    return json.dumps(dict(version=3, session=SESSION, id=ID, **extra)).encode() + b'\n'


class ProtocolTests(unittest.TestCase):
    def bootstrap(self):
        config = {key: os.path.abspath(key) for key in ('source', 'assets', 'profile')}
        config['preferences'] = dict(size=256, hideInFullscreen=True, scheduledActivity=False, movement=True)
        return frame(command='bootstrap', config=config)

    def test_bootstrap_and_fixed_requests(self):
        value = parse_bootstrap(self.bootstrap())
        self.assertEqual(value['session'], SESSION)
        for command in ('status', 'stop', 'show', 'hide'):
            self.assertEqual(parse_request(frame(command=command), SESSION)['command'], command)
        preferences = dict(size=320, hideInFullscreen=False)
        self.assertEqual(parse_request(frame(command='apply', preferences=preferences), SESSION)['preferences'], preferences)

    def test_behavior_preferences_are_required_in_bootstrap_and_fixed_for_apply(self):
        preferences = dict(scheduledActivity=True, movement=False)
        self.assertEqual(parse_request(frame(command='apply-behavior', preferences=preferences), SESSION)['preferences'], preferences)
        for value in ({'scheduledActivity': True}, {'scheduledActivity': 1, 'movement': False},
                      {**preferences, 'taskActive': False}, {**preferences, 'paused': False}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_request(frame(command='apply-behavior', preferences=value), SESSION)
        data = json.loads(self.bootstrap())
        data['config']['preferences'].pop('movement')
        with self.assertRaises(ValueError):
            parse_bootstrap(json.dumps(data).encode() + b'\n')

    def test_rejects_extra_fields_commands_and_bad_session(self):
        for data in (frame(command='eval'), frame(command='stop', path='/private'),
                     frame(command='apply', preferences={'size': 999, 'hideInFullscreen': False}),
                     frame(command='apply', preferences={'size': 256, 'hideInFullscreen': False, 'path': '/private'}),
                     frame(command='show', visible=False),
                     frame(command='status').replace(SESSION.encode(), b'c' * 64),
                     self.bootstrap()):
            with self.subTest(data=data), self.assertRaises(ValueError):
                parse_request(data, SESSION)

    def test_rejects_duplicate_keys_types_versions_and_non_utf8(self):
        for data in (frame(command='status').replace(b'"version": 3', b'"version": 3, "version": 3'),
                     frame(command='status').replace(b'"version": 3', b'"version": true'),
                     frame(command='status').replace(b'"version": 3', b'"version": 1'),
                     frame(command='status').replace(b'"version": 3', b'"version": 2'),
                     frame(command='status').replace(ID.encode(), b'not-an-id'), b'\xff\n'):
            with self.subTest(data=data), self.assertRaises(ValueError):
                parse_request(data, SESSION)

    def test_bootstrap_paths_are_absolute_and_only_known_fields(self):
        base = {'source': '/s', 'assets': '/a', 'profile': '/p', 'preferences': dict(size=256, hideInFullscreen=True, scheduledActivity=False, movement=True)}
        for config in ({**base, 'source': 'relative'}, {**base, 'script': '/x'},
                       {**base, 'profile': '/p\x00'}, {**base, 'preferences': dict(size=512, hideInFullscreen=True)}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                parse_bootstrap(frame(command='bootstrap', config=config))

    def test_bootstrap_position_requires_a_bounded_complete_coordinate_pair(self):
        config = json.loads(self.bootstrap())['config']
        config['preferences'].update(x=100, y=-120)
        self.assertEqual(parse_bootstrap(frame(command='bootstrap', config=config))['config']['preferences']['x'], 100)
        for position in ({'x': 10}, {'x': 1_000_001, 'y': 20}, {'x': True, 'y': 20}):
            preferences = {'size': 256, 'hideInFullscreen': True, **position}
            invalid = dict(config, preferences=preferences)
            with self.subTest(position=position), self.assertRaises(ValueError):
                parse_bootstrap(frame(command='bootstrap', config=invalid))

    def test_bounded_complete_frames_and_eof(self):
        self.assertIsNone(read_frame(io.BytesIO()))
        self.assertEqual(read_frame(io.BytesIO(b'{}\n')), b'{}\n')
        for data in (b'{}', b'x' * 4096 + b'\n'):
            with self.assertRaises(ValueError):
                read_frame(io.BytesIO(data))

    def test_reply_contains_no_session_config_or_error_text(self):
        self.assertEqual(json.loads(reply(ID, 'running')), dict(version=3, id=ID, ok=True, phase='running'))
        self.assertEqual(json.loads(reply(ID, 'error'))['ok'], False)
        with self.assertRaises(ValueError):
            reply(ID, '/private/exception')

    def test_position_feedback_is_versioned_integer_coordinates_with_bounds(self):
        self.assertEqual(json.loads(position_event(120, -45)),
                         {'version': 3, 'event': 'position', 'x': 120, 'y': -45})
        for x, y in ((True, 0), (0, False), (1_000_001, 0), (0, -1_000_001), (1.5, 0)):
            with self.subTest(x=x, y=y), self.assertRaises(ValueError):
                position_event(x, y)

    def test_importing_protocol_does_not_import_qt_or_legacy_pet(self):
        self.assertNotIn('PySide6', sys.modules)
        self.assertNotIn('pet', sys.modules)

class GuardianPlayerTests(unittest.TestCase):
    def test_guardian_flushes_queued_requests_and_output_before_eof(self):
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory(prefix='pet-guardian-eof-') as directory:
            worker = Path(directory) / 'echo.py'
            worker.write_text('import sys\nfor line in sys.stdin.buffer:\n sys.stdout.buffer.write(line); sys.stdout.buffer.flush()\n')
            result = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).with_name('guardian.py')), str(worker), '--player'],
                                    input=b'first\nsecond\n', capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'first\nsecond\n')

class WorkerBoundaryTests(unittest.TestCase):
    def test_invalid_bootstrap_exits_without_importing_qt_or_emitting_private_errors(self):
        import subprocess
        worker = str(Path(__file__).with_name('player_worker.py'))
        for data in (b'', b'{}\n', frame(command='bootstrap', config={'source': 'relative', 'assets': '/a', 'profile': '/p'})):
            result = subprocess.run([sys.executable, '-I', '-B', '-u', worker], input=data, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b'')
            self.assertEqual(result.stderr, b'')

    def test_guardian_mode_and_path_are_fixed(self):
        import subprocess
        guardian = str(Path(__file__).with_name('guardian.py'))
        for args in (['relative.py'], [str(Path(__file__)), '--arbitrary'], [str(Path(__file__)), '--player', '--extra']):
            result = subprocess.run([sys.executable, '-I', '-B', guardian, *args], capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b'')
