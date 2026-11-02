"""后台顺序解码、有界双层缓存；GUI 线程只取成品并创建 QPixmap。"""
from collections import OrderedDict
from pathlib import Path
import struct
import threading
import time

from PIL import Image
from PySide6.QtGui import QImage, QPixmap


def webp_frame_durations(path):
    """只读取 RIFF chunk 头，避免为所有动作载入完整压缩文件。"""
    with open(path, 'rb') as source:
        header = source.read(12)
        if len(header) != 12 or header[:4] != b'RIFF' or header[8:] != b'WEBP':
            raise ValueError('不是有效 WebP：' + str(path))
        end = struct.unpack('<I', header[4:8])[0] + 8
        if end > Path(path).stat().st_size:
            raise ValueError('WebP 文件已截断')
        durations = []
        while source.tell() + 8 <= end:
            kind, length = struct.unpack('<4sI', source.read(8))
            if source.tell() + length > end:
                raise ValueError('WebP chunk 越界')
            if kind == b'ANMF':
                if length < 16:
                    raise ValueError('WebP 帧头已截断')
                frame_header = source.read(16)
                durations.append(max(1, int.from_bytes(frame_header[12:15], 'little')))
                source.seek(length - 16 + (length & 1), 1)
            else:
                source.seek(length + (length & 1), 1)
        return durations or [100]


def webp_frame_count(path):
    return len(webp_frame_durations(path))


def decode_image(source, index, size):
    source.seek(index)
    # RGBa 是预乘 alpha；Qt 中保持预乘，避免透明边缘经历不必要的反预乘量化。
    image = source.convert('RGBA').convert('RGBa')
    if image.size != (size, size):
        image = image.resize((size, size), Image.Resampling.LANCZOS)
    raw = image.tobytes()
    return QImage(raw, size, size, size * 4,
                  QImage.Format.Format_RGBA8888_Premultiplied).copy()


class AnimationResourceBudget:
    """Distribute process-wide pixel budgets and serialize decode work."""
    def __init__(self, image_bytes=48 * 1024 * 1024,
                 pixmap_bytes=8 * 1024 * 1024, max_decoders=1):
        if image_bytes < 0 or pixmap_bytes < 0 or max_decoders < 1:
            raise ValueError('动画资源预算无效')
        self.image_bytes = image_bytes
        self.pixmap_bytes = pixmap_bytes
        self.decode_slots = threading.BoundedSemaphore(max_decoders)
        self._lock = threading.RLock()
        self._stores = set()
        self._owner_thread = threading.get_ident()

    def _on_owner_thread(self):
        # Rebalancing may evict QPixmaps, so lifecycle calls stay on the GUI thread.
        if threading.get_ident() != self._owner_thread:
            raise RuntimeError('像素预算注册和回收必须在所属 GUI 线程执行')

    def register(self, store):
        self._on_owner_thread()
        with self._lock:
            self._stores.add(store)
            self._rebalance()

    def unregister(self, store):
        self._on_owner_thread()
        with self._lock:
            self._stores.discard(store)
            self._rebalance()

    def _rebalance(self):
        stores = tuple(self._stores)
        if not stores:
            return
        image_share, image_remainder = divmod(self.image_bytes, len(stores))
        pixmap_share, pixmap_remainder = divmod(self.pixmap_bytes, len(stores))
        for index, store in enumerate(stores):
            store._set_budgets(image_share + (index < image_remainder),
                               pixmap_share + (index < pixmap_remainder))

    @property
    def active_stores(self):
        with self._lock:
            return len(self._stores)


GLOBAL_ANIMATION_BUDGET = AnimationResourceBudget()


class AnimationFrameStore:
    def __init__(self, max_bytes=48 * 1024 * 1024, max_decoders=1,
                 pixmap_bytes=8 * 1024 * 1024, prefetch=8,
                 resource_budget=None):
        self.max_bytes = max(0, max_bytes)
        self.pixmap_budget = max(0, pixmap_bytes)
        self.resource_budget = resource_budget
        self.prefetch = max(1, prefetch)
        self.frames = OrderedDict()
        self.pixmaps = OrderedDict()  # 仅 GUI 线程访问
        self.cached_bytes = 0
        self.pixmap_bytes = 0
        self.condition = threading.Condition()
        self.active = None
        self.generation = 0
        self.closed = False
        self.errors = {}
        self.stats = dict(decoded=0, cache_hits=0, misses=0, stale=0,
                          decode_ms=0.0, peak_bytes=0)
        self.thread = threading.Thread(target=self._run, name='dragon-webp', daemon=True)
        if self.resource_budget is not None:
            self.resource_budget.register(self)
        try:
            self.thread.start()
        except Exception:
            if self.resource_budget is not None:
                self.resource_budget.unregister(self)
            raise

    def _set_budgets(self, image_bytes, pixmap_bytes):
        with self.condition:
            self.max_bytes = image_bytes
            while self.frames and self.cached_bytes > self.max_bytes:
                _, (_, cost) = self.frames.popitem(last=False)
                self.cached_bytes -= cost
        self.pixmap_budget = pixmap_bytes
        while self.pixmaps and self.pixmap_bytes > self.pixmap_budget:
            _, (_, cost) = self.pixmaps.popitem(last=False)
            self.pixmap_bytes -= cost

    def activate(self, path, size, count):
        with self.condition:
            if self.closed:
                return
            self.generation += 1
            self.active = (str(path), size, 0, count)
            self.condition.notify_all()

    def request(self, path, size, index, count):
        with self.condition:
            name = str(path)
            if self.closed:
                return
            if self.active is None or self.active[:2] != (name, size):
                self.generation += 1
            self.active = (name, size, index, count)
            self.condition.notify_all()

    def error(self, path):
        with self.condition:
            return self.errors.get(str(path))

    def ready(self, path, size, index):
        """非阻塞；必须在 GUI 线程调用。"""
        key = (str(path), size, index)
        if key in self.pixmaps:
            self.pixmaps.move_to_end(key)
            return self.pixmaps[key][0]
        with self.condition:
            entry = self.frames.get(key)
            if entry is None:
                self.stats['misses'] += 1
                return None
            self.frames.move_to_end(key)
            self.stats['cache_hits'] += 1
            image, cost = entry
        pixmap = QPixmap.fromImage(image)
        if cost <= self.pixmap_budget:
            while self.pixmaps and self.pixmap_bytes + cost > self.pixmap_budget:
                _, (_, removed) = self.pixmaps.popitem(last=False)
                self.pixmap_bytes -= removed
            self.pixmaps[key] = (pixmap, cost)
            self.pixmap_bytes += cost
        return pixmap

    def frame(self, path, size, index):
        """仅兼容离线自检；实际播放走 request/ready，不在绘制时等待。"""
        result = self.ready(path, size, index)
        if result is not None:
            return result
        self.request(path, size, index, webp_frame_count(path))
        key = (str(path), size, index)
        deadline = time.monotonic() + 15
        with self.condition:
            while key not in self.frames:
                if self.closed:
                    raise RuntimeError('播放器已关闭')
                if str(path) in self.errors:
                    raise RuntimeError(self.errors[str(path)])
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('解码超时：' + str(path))
                self.condition.wait(remaining)
        return self.ready(path, size, index)

    def _run(self):
        decoder = None
        decoder_name = None
        try:
            while True:
                with self.condition:
                    job = None
                    while not self.closed and job is None:
                        if self.active is not None:
                            name, size, index, count = self.active
                            if name not in self.errors:
                                # 不提前绕回第 0 帧，避免顺序 WebP 解码器在片尾反复倒带。
                                horizon = min(self.prefetch, max(1, self.max_bytes // (size * size * 4)))
                                for candidate in range(index, min(count, index + horizon)):
                                    if (name, size, candidate) not in self.frames:
                                        job = (name, size, candidate, self.generation)
                                        break
                        if job is None:
                            self.condition.wait()
                    if self.closed:
                        break
                name, size, index, generation = job
                try:
                    slot = (self.resource_budget.decode_slots
                            if self.resource_budget is not None else None)
                    acquired = False
                    if slot is not None:
                        while not acquired:
                            acquired = slot.acquire(timeout=.1)
                            if not acquired:
                                with self.condition:
                                    if self.closed:
                                        break
                    if slot is not None and not acquired:
                        break
                    try:
                        with self.condition:
                            if self.closed:
                                break
                            if generation != self.generation:
                                self.stats['stale'] += 1
                                continue
                        started = time.perf_counter()
                        if name != decoder_name:
                            if decoder is not None:
                                decoder.close()
                            decoder = Image.open(name)
                            decoder_name = name
                        image = decode_image(decoder, index, size)
                    finally:
                        if slot is not None:
                            slot.release()
                    elapsed = (time.perf_counter() - started) * 1000
                except Exception as error:
                    with self.condition:
                        self.errors[name] = str(error)
                        self.condition.notify_all()
                    continue
                with self.condition:
                    if self.closed:
                        break
                    if generation != self.generation:
                        self.stats['stale'] += 1
                        continue
                    cost = image.sizeInBytes()
                    if cost > self.max_bytes:
                        self.errors[name] = '帧大于配置的像素缓存预算'
                        self.condition.notify_all()
                        continue
                    while self.frames and self.cached_bytes + cost > self.max_bytes:
                        _, (_, old_cost) = self.frames.popitem(last=False)
                        self.cached_bytes -= old_cost
                    self.frames[(name, size, index)] = (image, cost)
                    self.cached_bytes += cost
                    self.stats['decoded'] += 1
                    self.stats['decode_ms'] += elapsed
                    self.stats['peak_bytes'] = max(self.stats['peak_bytes'], self.cached_bytes)
                    self.condition.notify_all()
        finally:
            if decoder is not None:
                decoder.close()

    def close(self, wait=True):
        if wait and self.resource_budget is not None:
            self.resource_budget._on_owner_thread()
        with self.condition:
            self.closed = True
            self.condition.notify_all()
        if not wait:
            return
        self.thread.join()  # 正常关闭时等待当前一个解码操作结束，不遗留 Qt 对象后台访问。
        with self.condition:
            self.frames.clear()
            self.cached_bytes = 0
        self.pixmaps.clear()
        self.pixmap_bytes = 0
        if self.resource_budget is not None:
            self.resource_budget.unregister(self)


class LazyAnimationFrames:
    def __init__(self, store, path, size):
        self.store, self.path, self.size = store, Path(path), size
        self.durations_ms = webp_frame_durations(self.path)
        self.count = len(self.durations_ms)

    def __len__(self):
        return self.count

    def __getitem__(self, index):
        if index < 0:
            index += self.count
        if not 0 <= index < self.count:
            raise IndexError(index)
        return self.store.frame(self.path, self.size, index)

    def request(self, index):
        self.store.request(self.path, self.size, index, self.count)

    def ready(self, index):
        return self.store.ready(self.path, self.size, index)
