"""非阻塞的本机互动朗读提示；不读取账号、任务或在线内容。"""
import json
import os
from pathlib import Path
import queue
import socket
import threading


SOCKET_NAME = 'control.sock'
MAX_TEXT = 120
MAX_PAYLOAD = 2048
MIN_BUBBLE_MS = 3000
MAX_BUBBLE_MS = 30000


def should_send_interaction_cue(*, task_active=False, modal_active=False, popup_active=False):
    # Task bubbles are useful status updates; only active UI interactions defer speech.
    return not (modal_active or popup_active)


def speech_summary(*parts):
    text = ' '.join(' '.join(str(part).split()) for part in parts if part is not None)
    if len(text) <= MAX_TEXT:
        return text
    clipped = text[:MAX_TEXT - 1]
    boundary = max(clipped.rfind('。'), clipped.rfind('！'), clipped.rfind('？'), clipped.rfind('，'))
    if boundary >= MAX_TEXT // 2:
        clipped = clipped[:boundary + 1]
    return clipped.rstrip() + '…'


def speech_display_ms(text):
    """Bounded UI fallback: keep a bubble visible for the estimated TTS span."""
    compact = ''.join(str(text or '').split())
    estimate = 1800 + len(compact) * 210
    return max(MIN_BUBBLE_MS, min(MAX_BUBBLE_MS, estimate))


class SpeechCueClient:
    def __init__(self, directory=None, timeout=0.15):
        value = directory or os.environ.get('BAILONG_DATA_DIR')
        self.directory = Path(value).expanduser() if value else None
        self.timeout = timeout
        self._latest = queue.Queue(maxsize=1)
        self._worker = None
        self._worker_lock = threading.Lock()
        self._closed = False

    @staticmethod
    def _validate(text):
        if not isinstance(text, str):
            return False
        text = text.strip()
        return bool(text) and len(text) <= MAX_TEXT and not any(ord(char) < 32 or ord(char) == 127 for char in text)

    def send(self, text):
        """Best-effort delivery; failure is deliberately invisible to the Qt UI."""
        text = text.strip() if isinstance(text, str) else text
        if not self._validate(text):
            return False
        if self.directory is None:
            return False
        path = self.directory / SOCKET_NAME
        payload = json.dumps({'command': 'speak', 'text': text}, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n'
        if len(payload) > MAX_PAYLOAD or not path.exists():
            return False
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(self.timeout)
                connection.connect(str(path))
                connection.sendall(payload)
            return True
        except (OSError, ValueError):
            return False

    def send_async(self, text):
        if self._closed or not self._validate(text):
            return False
        self._ensure_worker()
        text = text.strip()
        try:
            self._latest.put_nowait(text)
        except queue.Full:
            try:
                self._latest.get_nowait()
            except queue.Empty:
                pass
            try:
                self._latest.put_nowait(text)
            except queue.Full:
                return False
        return True

    def _ensure_worker(self):
        with self._worker_lock:
            if self._worker is not None:
                return
            self._worker = threading.Thread(target=self._run, name='pet-speech-cue', daemon=True)
            self._worker.start()

    def _run(self):
        while True:
            text = self._latest.get()
            if text is None:
                return
            self.send(text)

    def close(self):
        self._closed = True
        try:
            self._latest.get_nowait()
        except queue.Empty:
            pass
        try:
            self._latest.put_nowait(None)
        except queue.Full:
            pass
        worker = self._worker
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=self.timeout + 0.05)
