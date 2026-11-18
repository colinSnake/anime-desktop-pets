"""stdlib-only owned process; never imports Qt or accesses accounts."""
import json
import os
from pathlib import Path
import signal
import sys
import time

bootstrap = json.loads(sys.stdin.readline())
config = bootstrap['config']
mode = Path(__file__).stem
Path(config['profile'], 'worker.pid').write_text(str(os.getpid()))
assert all(key not in os.environ for key in ('PET_MODEL_API_KEY', 'PYTHONPATH', 'PET_TASK_LEASE', 'BAILONG_PET_LIBRARY_DIR'))
assert os.environ['HOME'] == str(Path(config['profile']) / 'home')
assert os.environ['BAILONG_DATA_DIR'] == str(Path(config['profile']) / 'data')
assert os.environ['CODEX_HOME'] == str(Path(config['profile']) / 'disabled-codex')
if mode == 'hang':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        time.sleep(.1)
if mode == 'noisy':
    sys.stdout.write('x' * 8192); sys.stdout.flush()
elif mode == 'exit':
    sys.exit(1)
else:
    if mode in ('position-bootstrap', 'behavior'):
        Path(config['profile'], 'bootstrap-preferences.json').write_text(json.dumps(config['preferences']))
    def send(request_id, phase):
        print(json.dumps(dict(version=3, id=request_id, ok=phase != 'error', phase=phase), separators=(',', ':')), flush=True)
    if mode == 'slow-ready':
        time.sleep(.2)
    send('wrong' if mode == 'wrong-id' else bootstrap['id'], 'running')
    if mode == 'position':
        print(json.dumps(dict(version=3, event='position', x=120, y=240), separators=(',', ':')), flush=True)
    elif mode == 'invalid-position':
        # Exercise an event delivered after the first-frame reply, not the same pipe chunk.
        time.sleep(.05)
        print(json.dumps(dict(version=3, event='position', x=1_000_001, y=240), separators=(',', ':')), flush=True)
    if mode == 'self-stop':
        time.sleep(.1)
        print('{"version":3,"event":"stopped"}', flush=True)
        sys.exit(0)
    for line in sys.stdin:
        request = json.loads(line)
        assert request['session'] == bootstrap['session']
        if mode == 'stop-hang' and request['command'] == 'stop':
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            while True:
                time.sleep(.1)
        if request['command'] == 'apply-behavior':
            Path(config['profile'], 'behavior-command.json').write_text(json.dumps(request['preferences']))
        send(request['id'], 'stopped' if request['command'] == 'stop' else 'running')
        if request['command'] == 'stop':
            break
