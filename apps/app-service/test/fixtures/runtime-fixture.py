"""测试自有子进程故障；不访问桌面或用户资料。"""
import json
import pathlib
import os
import sys
import time

mode = pathlib.Path(sys.argv[0]).stem
if mode == 'noisy':
    sys.stdout.write('x' * 5000)
    sys.stdout.flush()
elif mode == 'wrong-id':
    sys.stdin.readline()
    print(json.dumps({'version': 1, 'id': 'wrong', 'ok': True, 'kind': 'diagnostic'}), flush=True)
elif mode == 'wrong-version':
    request = json.loads(sys.stdin.readline())
    print(json.dumps({'version': 2, 'id': request['id'], 'ok': True, 'kind': 'diagnostic'}), flush=True)
elif mode == 'env':
    request = json.loads(sys.stdin.readline())
    isolated = not any(key in os.environ for key in ('PET_MODEL_API_KEY', 'PYTHONPATH', 'PYTHONSTARTUP'))
    print(json.dumps({'version': 1, 'id': request['id'], 'ok': isolated, 'kind': 'diagnostic'}), flush=True)
    sys.stdin.read()
elif mode == 'exit':
    sys.exit(3)
else:
    time.sleep(30)
