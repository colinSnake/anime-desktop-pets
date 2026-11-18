"""Fixed stdin/stdout adapter: bootstrap once, then only literal poll frames."""
import json
import os
import sys


def main():
    if len(sys.argv) != 1 or os.name != 'posix' or sys.version_info < (3, 10):
        return 1
    line = sys.stdin.buffer.readline(4097)
    if not line.endswith(b'\n') or len(line) > 4096:
        return 1
    request = json.loads(line)
    if not isinstance(request, dict) or set(request) != {'home'}:
        return 1
    home = request['home']
    if not isinstance(home, str) or not home.startswith('/') or '\x00' in home:
        return 1
    sys.path.insert(0, os.path.dirname(__file__))  # Trusted staged siblings, not the user home.
    from task_reader import LocalTaskReader
    reader = LocalTaskReader(home)
    while True:
        line = sys.stdin.buffer.readline(6)
        if not line:
            return 0
        if line != b'poll\n':
            return 1
        snapshot = reader.poll()
        response = {'state': snapshot.state, 'activeCount': snapshot.active_count, 'startSerial': snapshot.start_serial}
        print(json.dumps(response, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)  # No exception dumps, paths, or session contents.
