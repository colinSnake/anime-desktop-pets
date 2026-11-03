"""姿态时钟与短混合：缺帧冻结姿态；普通移动跟随它，甩动弹簧独立计时。"""
from bisect import bisect_right
from collections import OrderedDict
import math
import hashlib
import json
from functools import lru_cache
from pathlib import Path


def release_source_key(item):
    keys = ('id', 'file', 'playbackFile', 'durationMs', 'moveStartMs', 'moveStopMs', 'sourceFacing')
    payload = {key: item.get(key) for key in keys}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


@lru_cache(maxsize=16)
def _release_catalog(path, mtime, size):
    try:
        content = json.loads(Path(path).read_text())
        return content.get('profiles', {}) if content.get('schema') == 1 else {}
    except (OSError, ValueError, AttributeError):
        return {}


def release_clip(item, catalog):
    """仅松手使用可追溯短缓存，缺失／不匹配安全退回原素材。"""
    catalog = Path(catalog)
    try:
        stat = catalog.stat()
        if stat.st_size > 65536:
            return item
        profile = _release_catalog(str(catalog), stat.st_mtime_ns, stat.st_size).get(item['id'], {})
        if profile.get('sourceKey') != release_source_key(item):
            return item
        relative = Path(profile.get('file', ''))
        root = catalog.parent.parent.resolve()
        target = (root / relative).resolve()
        duration = profile.get('durationMs', 0)
        if (relative.is_absolute() or '..' in relative.parts or not target.is_relative_to(root)
                or relative.parts[:1] != ('dragon-release',) or target.suffix != '.webp'
                or not target.is_file() or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or not 0 < duration <= item.get('durationMs', 0)):
            return item
        result = dict(item, playbackFile=str(relative), durationMs=duration,
                      moveStartMs=0, moveStopMs=duration, releaseSource=item['id'])
        if item.get('_flightSizeProfile') == 'bailong-left-v1':
            # The fixed source has 273 frames / 9100ms. Keep the source pose
            # time when a release loop starts partway through that artwork.
            first = profile.get('sourceFirstFrame')
            if not isinstance(first, int) or not 0 <= first < 273:
                return item
            result['_flightSourceStartMs'] = first * 9100 / 273
        return result
    except (OSError, ValueError, TypeError, AttributeError):
        return item


def transition_profile(previous_mode, mode, default_idle=False, reduced=False):
    """拖拽相关姿态用固定校准尺寸；落底后缓和回待机，不用尾巴/翅膀外框缩放。"""
    drag_related = previous_mode in ('drag', 'autonomous-motion') or mode in ('drag', 'autonomous-motion')
    returning = drag_related and mode == 'idle' and default_idle
    return (0. if reduced else .28 if returning else .16), drag_related


class PresentationClock:
    MAX_STEP = .050  # GUI 卡顿或隐藏恢复后不追赶过期帧。

    def __init__(self, durations_ms, duration, now, start_ms=0, blend=.16):
        if not durations_ms or any(not math.isfinite(d) or d <= 0 for d in durations_ms):
            raise ValueError('帧时长必须为正数')
        self.duration = float(duration)
        if not math.isfinite(self.duration) or self.duration <= 0:
            raise ValueError('动作时长无效')
        total = sum(durations_ms)
        # 上游部分清单取整：保持帧时间比例，并对齐动作/位移元数据总时长。
        self.starts = []
        position = 0.
        for value in durations_ms:
            self.starts.append(position * self.duration / total)
            position += value
        self.offset = max(0., min(start_ms / 1000, self.duration - .001))
        self.elapsed = 0.
        self.index = self.index_at(self.offset)
        self.last = now
        self.waiting = True
        self.blend_duration = max(0., blend)
        self.blend_elapsed = 0.
        self.finished = False
        self.loop_range = None
        self.loop_cycle = 0
        self.looped = False
        self.loop_blend = .06
        self.seam_elapsed = self.loop_blend
        self.stalled = False
        self.blocked_since = now

    @property
    def length(self):
        return self.duration - self.offset

    @property
    def blending(self):
        return not self.waiting and self.blend_elapsed < self.blend_duration

    @property
    def loop_blending(self):
        return self.loop_range is not None and self.seam_elapsed < self.loop_blend

    def begin_seam(self):
        self.seam_elapsed = 0.

    @property
    def alpha(self):
        if self.waiting:
            return 0.
        initial = min(1., self.blend_elapsed / self.blend_duration) if self.blend_duration else 1.
        seam = min(1., self.seam_elapsed / self.loop_blend) if self.loop_blend else 1.
        t = min(initial, seam) if self.loop_range else initial
        return t * t * (3 - 2 * t)

    def index_at(self, seconds):
        return max(0, min(len(self.starts) - 1, bisect_right(self.starts, seconds) - 1))

    def timed_out(self, now):
        return self.blocked_since is not None and now - self.blocked_since > 5.

    def set_loop(self, start, stop):
        """循环已审核的有效运动段，不重新混合、不重建播放器或物理时钟。"""
        if not (math.isfinite(start) and math.isfinite(stop) and 0 <= start < stop <= self.duration):
            raise ValueError('循环运动段无效')
        self.loop_range = (start, stop)
        self.finished = False

    def advance(self, now, ready):
        self.looped = False
        dt = max(0., min(self.MAX_STEP, now - self.last))
        self.last = now
        if self.waiting:
            if ready(self.index):
                self.waiting = False
                self.blocked_since = None
            return
        target = self.elapsed + dt
        position = self.offset + target
        cycle = 0
        if self.loop_range is None:
            target = min(self.length, target)
            position = self.offset + target
        else:
            start, stop = self.loop_range
            if position >= stop:
                cycle = 1 + int((position - stop) // (stop - start))
                position = start + (position - stop) % (stop - start)
        index = self.index_at(position)
        self.stalled = not ready(index)
        if self.stalled and self.blocked_since is None:
            self.blocked_since = now
        if not self.stalled:
            self.blocked_since = None
            if self.blending:
                self.blend_elapsed = min(self.blend_duration, self.blend_elapsed + dt)
            if self.loop_range is not None:
                self.looped = cycle != self.loop_cycle
                self.loop_cycle = cycle
                self.seam_elapsed = 0. if self.looped else min(self.loop_blend, self.seam_elapsed + dt)
            self.index, self.elapsed = index, target
            self.finished = self.loop_range is None and target >= self.length


def canvas_padding(size):
    """Rendering-only overscan; the menu size still defines the character canvas."""
    return round(size * .25)


def pose_pixmap(frame, item, size, *, mirror=False, position_ms=0., padding=0):
    """将素材锚点、缩放和偏移固化到同一个窗口坐标系；仅 GUI 线程调用。"""
    from PySide6.QtCore import QRectF, Qt
    from PySide6.QtGui import QPixmap, QPainter
    result = QPixmap(size + 2 * padding, size + 2 * padding)
    result.fill(Qt.GlobalColor.transparent)
    if frame is None:
        return result
    scale, offset = flight_render_geometry(item, position_ms)
    width = size * scale
    target = QRectF((size - width) / 2 + size * offset[0], size - width + size * offset[1], width, width)
    painter = QPainter(result)
    painter.translate(padding, padding)
    painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
    if mirror:
        painter.translate(size if item.get('_flightSizeProfile') else 2 * target.center().x(), 0)
        painter.scale(-1, 1)
    painter.drawPixmap(target, frame, QRectF(frame.rect()))
    painter.end()
    return result


def pose_bridge(source, target):
    """根据切换首帧计算一次桥接变换，避免逐动画帧重新测量并产生缩放抖动。"""
    if source is None or target is None:
        return None
    source_box, target_box = _alpha_bounds(source), _alpha_bounds(target)
    if not source_box or not target_box:
        return None
    source_width, source_height = source_box[2] - source_box[0], source_box[3] - source_box[1]
    target_width, target_height = target_box[2] - target_box[0], target_box[3] - target_box[1]
    source_size, target_size = max(source_width, source_height), max(target_width, target_height)
    if target_size <= 0:
        return None
    desired = max(.9, min(1.1, source_size / target_size))
    source_center = ((source_box[0] + source_box[2]) / 2, (source_box[1] + source_box[3]) / 2)
    target_center = ((target_box[0] + target_box[2]) / 2, (target_box[1] + target_box[3]) / 2)
    canvas_center = (target.width() / 2, target.height() / 2)
    return desired, source_center, target_center, canvas_center


_POSE_BRIDGE_UNSET = object()


# Only the pinned built-in clip is corrected; imported packages own their
# presentation metadata even when they happen to reuse a movement action ID.
_LEFT_FLIGHT_SOURCE_KEY = '084e6080b23112acad75d0f25a5d2a4e96bf5a0cffad6e490f87881b070d4148'


def calibrate_flight_sizes(manifest):
    """Attach artwork normalization in memory; never change menu size or source files."""
    for item in manifest.get('movementAnimations', []):
        if not item.get('_assetRoot') and release_source_key(item) == _LEFT_FLIGHT_SOURCE_KEY:
            item['_flightSizeProfile'] = 'bailong-left-v1'
    return manifest


def flight_render_geometry(item, position_ms=0.):
    """Known source-pose correction, not a frame/silhouette-dependent auto zoom.

    The left artwork shrinks its head/body while turning sideways. Normalize
    that section at 1.30 on a padded canvas; leave the already full-size right
    clip alone. Authored ramps follow the source's takeoff/return, so expanding
    the standing frames never clips their horns. No pixels are read here.
    """
    scale, offset = item.get('renderScale', 1.), item.get('renderOffset', [0, 0])
    if item.get('_flightSizeProfile') != 'bailong-left-v1':
        return scale, offset
    position = position_ms + item.get('_flightSourceStartMs', 0.)
    enter = max(0., min(1., (position - 2500.) / 625.))
    leave = max(0., min(1., (6700. - position) / 1000.))
    weight = min(enter, leave)
    weight = weight * weight * (3 - 2 * weight)
    return scale + (1.30 - scale) * weight, offset


def blend_pose(source, target, alpha, bridge=_POSE_BRIDGE_UNSET):
    """预乘 alpha 线性混合，避免 source-over 双重衰减；不声称是生成补帧。"""
    from PySide6.QtCore import Qt
    from PySide6.QtGui import QPixmap, QPainter
    if source is None or alpha >= 1:
        return target
    if alpha <= 0:
        return source
    # 不同动作的透明边界并不完全一致。过渡中直接交叉淡化会让角色的
    # 可见包围盒先缩小再恢复，尤其在拖拽释放接入新动作时很明显。先把
    # 目标姿态临时对齐到源姿态的可见尺寸，随后随 alpha 线性回到目标原尺。
    if bridge is _POSE_BRIDGE_UNSET:
        bridge = pose_bridge(source, target)
    target = _stabilized_target(target, alpha, bridge)
    result = QPixmap(target.size())
    result.fill(Qt.GlobalColor.transparent)
    painter = QPainter(result)
    painter.setOpacity(1 - alpha)
    painter.drawPixmap(0, 0, source)
    painter.end()
    # Qt raster 对 Plus + painter opacity 的组合可能退化成 source-over；
    # 先预乘目标层，再以全不透明度做 Plus，保证中点 alpha 不塌陷。
    overlay = QPixmap(target.size())
    overlay.fill(Qt.GlobalColor.transparent)
    ink = QPainter(overlay)
    ink.setOpacity(alpha)
    ink.drawPixmap(0, 0, target)
    ink.end()
    painter = QPainter(result)
    painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Plus)
    painter.drawPixmap(0, 0, overlay)
    painter.end()
    return result


_ALPHA_BOUNDS = OrderedDict()


def _alpha_bounds(pixmap):
    """返回透明画布上可见像素边界；仅在短过渡中调用。"""
    from PySide6.QtGui import QBitmap
    key = pixmap.cacheKey()
    if key in _ALPHA_BOUNDS:
        _ALPHA_BOUNDS.move_to_end(key)
        return _ALPHA_BOUNDS[key]
    bitmap = QBitmap.fromImage(pixmap.toImage().createAlphaMask())
    from PySide6.QtGui import QRegion
    bounds = QRegion(bitmap).boundingRect()
    result = (bounds.x(), bounds.y(), bounds.x() + bounds.width(), bounds.y() + bounds.height()) if not bounds.isNull() else None
    _ALPHA_BOUNDS[key] = result
    while len(_ALPHA_BOUNDS) > 128:
        _ALPHA_BOUNDS.popitem(last=False)
    return result


def _scaled_canvas(pixmap, factor, shift=(0., 0.)):
    from PySide6.QtCore import QRectF, Qt
    from PySide6.QtGui import QPixmap, QPainter
    if abs(factor - 1.) < .002:
        return pixmap
    result = QPixmap(pixmap.size())
    result.fill(Qt.GlobalColor.transparent)
    width, height = pixmap.width() * factor, pixmap.height() * factor
    painter = QPainter(result)
    painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
    painter.drawPixmap(QRectF((pixmap.width() - width) / 2 + shift[0],
                              (pixmap.height() - height) / 2 + shift[1], width, height),
                       pixmap, QRectF(pixmap.rect()))
    painter.end()
    return result


def _stabilized_target(target, alpha, bridge):
    if bridge is None or alpha <= 0 or alpha >= 1:
        return target
    desired, source_center, target_center, canvas_center = bridge
    factor = desired + (1. - desired) * alpha
    native_offset = (canvas_center[0] + (target_center[0] - canvas_center[0]) * factor,
                     canvas_center[1] + (target_center[1] - canvas_center[1]) * factor)
    desired_center = (source_center[0] + (target_center[0] - source_center[0]) * alpha,
                      source_center[1] + (target_center[1] - source_center[1]) * alpha)
    shift = (desired_center[0] - native_offset[0], desired_center[1] - native_offset[1])
    return _scaled_canvas(target, factor, shift)
