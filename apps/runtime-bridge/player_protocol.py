"""Private bounded NDJSON protocol. No Qt, filesystem reads, or user data."""
import json
import unicodedata
import os
import re

MAX_FRAME = 4096


def read_frame(stream):
    line = stream.readline(MAX_FRAME + 1)
    if not line:
        return None
    if len(line) > MAX_FRAME or not line.endswith(b'\n'):
        raise ValueError('invalid_frame')
    return line


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_field')
        result[key] = value
    return result


def _parse(line, fields):
    if not isinstance(line, bytes) or len(line) > MAX_FRAME or not line.endswith(b'\n'):
        raise ValueError('invalid_frame')
    try:
        value = json.loads(line.decode('utf-8'), object_pairs_hook=_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid_number')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError('invalid_json') from error
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('invalid_fields')
    if type(value['version']) is not int or value['version'] != 3:
        raise ValueError('invalid_version')
    if not isinstance(value['session'], str) or not re.fullmatch('[a-f0-9]{64}', value['session']):
        raise ValueError('invalid_session')
    if not isinstance(value['id'], str) or not re.fullmatch('[a-f0-9]{32}', value['id']):
        raise ValueError('invalid_id')
    return value


def parse_bootstrap(line):
    value = _parse(line, {'version', 'session', 'id', 'command', 'config'})
    if value['command'] != 'bootstrap':
        raise ValueError('invalid_command')
    config = value['config']
    if not isinstance(config, dict) or set(config) != {'source', 'assets', 'profile', 'preferences'}:
        raise ValueError('invalid_config')
    for path in (config['source'], config['assets'], config['profile']):
        if not isinstance(path, str) or not 1 <= len(path) <= 1024 or '\x00' in path or not os.path.isabs(path):
            raise ValueError('invalid_path')
    _preferences(config['preferences'], allow_position=True)
    return value


def parse_request(line, session):
    if not isinstance(line, bytes) or len(line) > MAX_FRAME or not line.endswith(b'\n'):
        raise ValueError('invalid_frame')
    try:
        raw = json.loads(line.decode('utf-8'), object_pairs_hook=_pairs,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid_number')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError('invalid_json') from error
    if not isinstance(raw, dict):
        raise ValueError('invalid_fields')
    if raw.get('command') == 'apply':
        value = _parse(line, {'version', 'session', 'id', 'command', 'preferences'})
        _preferences(value['preferences'])
    elif raw.get('command') == 'apply-behavior':
        value = _parse(line, {'version', 'session', 'id', 'command', 'preferences'})
        _behavior_preferences(value['preferences'])
    elif raw.get('command') == 'task-animation':
        value = _parse(line, {'version', 'session', 'id', 'command', 'task'})
        _task_animation(value['task'])
    else:
        value = _parse(line, {'version', 'session', 'id', 'command'})
    if value['session'] != session or value['command'] not in ('status', 'stop', 'show', 'hide', 'apply', 'apply-behavior', 'task-animation'):
        raise ValueError('invalid_request')
    return value


def _task_animation(value):
    if not isinstance(value, dict) or set(value) != {'state', 'startSerial', 'expiresAt'}:
        raise ValueError('invalid_task_animation')
    state, serial, deadline = value['state'], value['startSerial'], value['expiresAt']
    if (state not in ('working', 'idle', 'unknown', 'disabled') or
            any(type(n) is not int or not 0 <= n <= 2**53 - 1 for n in (serial, deadline)) or
            (deadline == 0 if state == 'working' else (serial != 0 or deadline != 0))):
        raise ValueError('invalid_task_animation')


def _preferences(value, allow_position=False):
    keys = {'size', 'hideInFullscreen'}
    if allow_position:
        keys.update(('scheduledActivity', 'movement'))
    if allow_position and isinstance(value, dict) and ('x' in value or 'y' in value):
        keys.update(('x', 'y'))
    if (not isinstance(value, dict) or set(value) != keys or
            type(value['size']) is not int or not 128 <= value['size'] <= 384 or
            type(value['hideInFullscreen']) is not bool):
        raise ValueError('invalid_preferences')
    if allow_position:
        _behavior_preferences({key: value[key] for key in ('scheduledActivity', 'movement')})
    if allow_position and ('x' in value or 'y' in value):
        if any(type(value.get(axis)) is not int or abs(value[axis]) > 1_000_000 for axis in ('x', 'y')):
            raise ValueError('invalid_preferences')


def _behavior_preferences(value):
    if (not isinstance(value, dict) or set(value) != {'scheduledActivity', 'movement'} or
            any(type(value[key]) is not bool for key in ('scheduledActivity', 'movement'))):
        raise ValueError('invalid_preferences')


def reply(request_id, phase):
    if phase not in ('starting', 'running', 'stopping', 'stopped', 'error'):
        raise ValueError('invalid_phase')
    return (json.dumps(dict(version=3, id=request_id, ok=phase != 'error', phase=phase),
                       separators=(',', ':')) + '\n').encode('utf-8')


def stopped_event():
    """Only emitted after GUI/decoder cleanup for a local user/EOF stop."""
    return b'{"version":3,"event":"stopped"}\n'


def position_event(x, y):
    """Encode only bounded logical-screen coordinates from a completed drag."""
    if (type(x) is not int or type(y) is not int or
            abs(x) > 1_000_000 or abs(y) > 1_000_000):
        raise ValueError('invalid_position')
    return (json.dumps(dict(version=3, event='position', x=x, y=y),
                       separators=(',', ':')) + '\n').encode('utf-8')


def bubble_speech_event(text):
    """A visible local interaction cue; no legacy socket, account or task lookup."""
    if (not isinstance(text, str) or not 0 < len(text) <= 120 or
            text.strip().strip('\ufeff') != text or
            any(unicodedata.category(char) in ('Cc', 'Cs') for char in text) or
            len(text.encode('utf-8')) > 512):
        raise ValueError('invalid_speech_cue')
    return (json.dumps(dict(version=3, event='bubble-speech', text=text),
                       ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
