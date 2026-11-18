"""有界 NDJSON 诊断协议；不是 Qt 桌宠，不访问网络、模型或用户资料。"""
import json
import sys

MAX_LINE = 4096


def reply(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def main():
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE or not line.endswith(b'\n'):
            reply({'version': 1, 'id': None, 'ok': False, 'error': 'invalid_message'})
            return
        try:
            message = json.loads(line)
            valid = (isinstance(message, dict) and set(message) == {'version', 'id', 'command'}
                     and type(message['version']) is int and message['version'] == 1
                     and isinstance(message['id'], str) and 0 < len(message['id']) <= 64
                     and message['command'] in ('probe', 'shutdown'))
        except (ValueError, TypeError):
            valid = False
        if not valid:
            reply({'version': 1, 'id': None, 'ok': False, 'error': 'invalid_message'})
            continue
        reply({'version': 1, 'id': message['id'], 'ok': True, 'kind': 'diagnostic'})
        if message['command'] == 'shutdown':
            return


if __name__ == '__main__':
    main()
