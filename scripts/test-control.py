#!/usr/bin/env python3
"""Exercise the real Unix socket in an isolated, no-window/no-Codex test server."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import stat

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description='隔离测试本地控制接口，不启动 Codex 或桌宠')
parser.add_argument('--binary',type=Path,default=ROOT/'build/Dragon Codex Companion.app/Contents/MacOS/DragonCompanion')
BIN = parser.parse_args().binary.resolve(strict=True)
with tempfile.TemporaryDirectory(prefix='dragon-control-', dir='/tmp') as directory:
    env = dict(os.environ, DRAGON_DATA_DIR=directory)
    server = subprocess.Popen([str(BIN),'--control-test-server'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def control(command):
        result = subprocess.run([str(BIN),'--'+command],env=env,capture_output=True,text=True,timeout=6)
        if result.returncode: raise AssertionError(result.stderr)
        return json.loads(result.stdout)
    try:
        path = Path(directory)/'control.sock'
        for _ in range(100):
            if path.exists(): break
            if server.poll() is not None: raise AssertionError(server.communicate()[1])
            time.sleep(.05)
        assert path.exists(), 'socket not ready'
        assert stat.S_IMODE(path.stat().st_mode)==0o600
        assert control('status').get('codexPID') is None
        assert not control('status')['petVisible']
        assert control('status')['petState']=='idle'
        assert control('status').get('petError') is None
        assert control('pause')['paused']
        assert not control('resume')['paused']
        assert control('hide')['phase']=='petHidden'
        assert control('dismiss')['phase']=='petDismissed'
        assert not control('show')['petVisible'], 'test mode must never open a pet window'
        # Unknown commands and oversized messages must not execute anything or kill the server.
        for message in (b'{"command":"run-shell"}\n', b'x'*8192):
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
                connection.settimeout(3); connection.connect(str(path)); connection.sendall(message)
                try: connection.recv(1024)
                except (ConnectionResetError,TimeoutError): pass
        assert control('status')['ok']
        # A second instance cannot own or delete the first instance's socket.
        second = subprocess.run([str(BIN),'--control-test-server'],env=env,capture_output=True,text=True,timeout=6)
        # 保持原有AppKit单实例契约：提示拒绝，且不能接管/删除现有Socket。
        assert '桌边小伙伴已经在运行了' in second.stderr
        assert control('status')['ok']
        control('quit'); server.wait(timeout=6)
        assert not path.exists(), 'socket not cleaned up'
        print('Control integration passed: isolation, permissions, commands, malformed input, singleton, cleanup.')
    finally:
        if server.poll() is None: server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill(); server.wait()
