"""独立 stdio 监护：服务死亡导致 stdin EOF 时，也回收无响应 worker。

此进程不运行 Qt 或推理；工作负载始终位于另一个自有子进程中。
"""
import os
import queue
import signal
import subprocess
import sys
import threading

MAX_LINE = 4096


def main():
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
        return 1
    stopped = threading.Event()
    parent_ended = threading.Event()
    incoming = queue.Queue(maxsize=1)
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    child = subprocess.Popen([sys.executable, '-I', '-B', '-u', sys.argv[1]], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)

    def read_parent():
        while not stopped.is_set():
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                parent_ended.set()
                return
            if len(line) > MAX_LINE or not line.endswith(b'\n'):
                stopped.set()
                return
            while not stopped.is_set():
                try:
                    incoming.put(line, timeout=0.05)
                    break
                except queue.Full:
                    pass

    def drain_worker():
        try:
            while True:
                chunk = os.read(child.stdout.fileno(), MAX_LINE)
                if not chunk:
                    return
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            stopped.set()

    def forward_input():
        # Only this daemon can block on a full child pipe. The supervisor thread
        # remains available to reap a hung worker after parent EOF or SIGTERM.
        try:
            while not stopped.is_set():
                try:
                    line = incoming.get(timeout=0.05)
                except queue.Empty:
                    if parent_ended.is_set():
                        return
                    continue
                child.stdin.write(line)
                child.stdin.flush()
        except (BrokenPipeError, OSError):
            stopped.set()
        finally:
            try:
                child.stdin.close()
            except OSError:
                pass

    threading.Thread(target=read_parent, daemon=True).start()
    output_thread = threading.Thread(target=drain_worker, daemon=True)
    output_thread.start()
    threading.Thread(target=forward_input, daemon=True).start()
    try:
        while not stopped.is_set() and child.poll() is None:
            if parent_ended.wait(0.05):
                break
    finally:
        # Allow the forwarder to flush queued frames and deliver EOF. Never close
        # its pipe here: a blocked writer must not block the independent reaper.
        if child.poll() is None:
            try:
                child.wait(timeout=0.15)
            except subprocess.TimeoutExpired:
                stopped.set()
                child.terminate()
                try:
                    child.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=1)
        else:
            child.wait()
        stopped.set()
        output_thread.join(timeout=0.5)
    return 0


if __name__ == '__main__':
    try:
        result = main()
    except (OSError, subprocess.SubprocessError):
        result = 1
    # 后台 I/O 线程是 daemon；绕过 Python 解释器关闭期间对其缓冲锁的等待。
    os._exit(result)
