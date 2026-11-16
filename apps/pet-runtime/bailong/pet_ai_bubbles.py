"""日常气泡预取缓存；纯 Python，工作线程不持有 Qt 对象或呈现回调。

choose() 始终立即返回下一条可用缓存或原本地文案。只传枚举事件；宿主
负责无工具生成、持久每日额度和全局冷却，本客户端失败也计入本机冷却。
"""
import json
import os
from pathlib import Path
import queue
import re
import socket
import stat
import threading
import time
import unicodedata
import uuid


MAX_SETTINGS_BYTES = 64 * 1024
MAX_REPLY_BYTES = 16 * 1024
MAX_TEXT = 60
CACHE_TTL = 30 * 60.
MIN_ATTEMPT_INTERVAL = 10 * 60.
RESPONSE_TIMEOUT = 10.  # 宿主异步生成上限 8 秒；为本机协议往返留余量。
EVENTS = frozenset(('idle', 'interaction', 'reminder'))


def _safe_message(value):
    """拒绝非纯文本、控制符和明显任务结果/工具片段；语义边界仍由宿主保证。"""
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT:
        return False
    if any(unicodedata.category(char) in ('Cc', 'Cf', 'Cs', 'Zl', 'Zp') for char in value):
        return False
    if any(char in value for char in '{}[]<>`\\'):
        return False
    return not re.search(
        r'完成|搞定|测试通过|构建成功|部署成功|https?://|www\.|'
        r'\b(?:completed?|finished|done|tool_calls?|function_calls?)\b', value, re.IGNORECASE)


class PetAIBubbleClient:
    def __init__(self, directory=None, *, timeout=RESPONSE_TIMEOUT, clock=time.monotonic):
        value = directory if directory is not None else os.environ.get('BAILONG_DATA_DIR')
        # 不使用实例 state_dir；所有桌宠共享宿主授权和 control.sock。
        self.directory = Path(value).expanduser() if value else None
        self.timeout = max(.001, min(RESPONSE_TIMEOUT, float(timeout)))
        self.clock = clock
        self._lock = threading.Lock()
        self._queue = queue.Queue(maxsize=1)
        self._worker = None
        self._connection = None
        self._closed = False
        self._pending = False
        self._last_attempt = None
        self._authorization = None
        self._generation = 0
        self._cache = {}

    def _read_authorization(self):
        if self.directory is None:
            return None
        try:
            # O_NONBLOCK 防 FIFO 卡住 GUI；O_NOFOLLOW 防跟随非普通设置入口。
            descriptor = os.open(self.directory / 'speech-settings.json',
                                 os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_SETTINGS_BYTES:
                    return None
                data = stream.read(MAX_SETTINGS_BYTES + 1)
                after = os.fstat(stream.fileno())
            def token(info):
                return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if len(data) > MAX_SETTINGS_BYTES or token(before) != token(after):
                return None
            settings = json.loads(data.decode('utf-8'))
            if not isinstance(settings, dict) or settings.get('aiBubblesEnabled') is not True:
                return None
            consent = settings.get('aiBubblesConsentID')
            if not isinstance(consent, str) or len(consent) != 36:
                return None
            return str(uuid.UUID(consent))
        except (OSError, ValueError, UnicodeError, RecursionError):
            return None

    def _authorized(self):
        """在锁内使用；绑定宿主 consent UUID，覆盖未观察到的关→开窗口。"""
        authorization = None if self._closed else self._read_authorization()
        if authorization != self._authorization:
            self._authorization = authorization
            self._generation += 1
            self._cache.clear()
        return authorization is not None

    def choose(self, event, fallback):
        """GUI 入口：不等待 socket/模型；缓存仅供下一次同类事件消费一次。"""
        if not isinstance(event, str) or event not in EVENTS:
            return fallback
        with self._lock:
            if not self._authorized():
                return fallback
            now = self.clock()
            cached = self._cache.pop(event, None)
            chosen = fallback
            if (cached is not None and cached[0] == self._generation
                    and now < cached[1] and _safe_message(cached[2])):
                chosen = cached[2]
            # 队列和正在进行的请求总计最多一个；失败/禁用不会清除冷却。
            if (not self._pending and (self._last_attempt is None
                                      or now - self._last_attempt >= MIN_ATTEMPT_INTERVAL)):
                # 排队前再次核对；设置变化时也不能返回此前选中的缓存。
                generation = self._generation
                if not self._authorized() or generation != self._generation:
                    return fallback
                self._last_attempt = now
                self._pending = True
                self._queue.put_nowait((event, generation))
                if self._worker is None:
                    self._worker = threading.Thread(target=self._run, name='pet-ai-bubbles', daemon=True)
                    try:
                        self._worker.start()
                    except RuntimeError:
                        # 线程资源不足也只回本地文案；这次尝试仍计入冷却。
                        self._worker = None
                        self._pending = False
                        self._queue.get_nowait()
            return chosen

    def _run(self):
        while True:
            item = self._queue.get()
            if item is None:
                return
            event, generation = item
            try:
                with self._lock:
                    if not self._authorized() or generation != self._generation:
                        continue
                reply = self._request(event)
                with self._lock:
                    if (self._authorized() and generation == self._generation
                            and isinstance(reply, dict) and reply.get('ok') is True
                            and _safe_message(reply.get('message'))):
                        self._cache[event] = (generation, self.clock() + CACHE_TTL, reply['message'])
            finally:
                with self._lock:
                    self._pending = False

    def _request(self, event):
        # 这里绝不接收 fallback/任务/身份/记忆，也不执行返回内容。
        payload = json.dumps({'command': 'bubble', 'event': event}, separators=(',', ':')).encode() + b'\n'
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                with self._lock:
                    if self._closed:
                        return None
                    self._connection = connection
                deadline = time.monotonic() + self.timeout
                connection.settimeout(self.timeout)
                connection.connect(str(self.directory / 'control.sock'))
                connection.sendall(payload)
                data = bytearray()
                while len(data) <= MAX_REPLY_BYTES:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return None
                    connection.settimeout(remaining)
                    chunk = connection.recv(min(4096, MAX_REPLY_BYTES + 1 - len(data)))
                    if not chunk:
                        return None
                    data.extend(chunk)
                    if len(data) > MAX_REPLY_BYTES:
                        return None
                    if b'\n' in chunk:
                        return json.loads(data.split(b'\n', 1)[0].decode('utf-8'))
        except (OSError, ValueError, UnicodeError, RecursionError):
            return None
        finally:
            with self._lock:
                self._connection = None
        return None

    def close(self):
        """撤销缓存并取消本机等待；GUI 最多短暂 join，不等待模型/Qt。"""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._authorization = None
            self._generation += 1
            self._cache.clear()
            connection = self._connection
            worker = self._worker
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            self._queue.put_nowait(None)
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=.05)
