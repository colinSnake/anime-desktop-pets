"""本地自主活动：低频决策与有界轨迹，复用原播放器和 16ms tick。"""
from collections import deque
from dataclasses import dataclass
import math
import random
import time

from PySide6.QtCore import QPoint
from PySide6.QtGui import QCursor
from PySide6.QtWidgets import QApplication

from dragon_ui import reduced_motion
from dragon_playback import release_clip


@dataclass(frozen=True)
class Motion:
    """逻辑像素轨迹；自主动作回到起点，松手弹跳停在短距离终点。"""
    kind: str
    origin: tuple
    travel: float
    height: float
    duration: float

    def position(self, progress):
        t = max(0., min(1., progress))
        if self.kind == 'settle':
            # 三段抛物线逐次衰减，最后保持在新落点。
            phases = ((0., .55, 1.), (.55, .84, .38), (.84, 1., .12))
            height = 0.
            for start, end, scale in phases:
                if start <= t < end:
                    u = (t - start) / (end - start)
                    height = self.height * scale * 4 * u * (1 - u)
                    break
            return round(self.origin[0] + self.travel * (1 - (1 - t) ** 3)), round(self.origin[1] - height)
        if t == 0 or t == 1:
            return self.origin
        wave = math.sin(math.pi * t)
        if self.kind == 'double-hop':
            x = self.travel * math.sin(2 * math.pi * t)
            y = -self.height * abs(math.sin(2 * math.pi * t))
        elif self.kind == 'dash':
            x = self.travel * wave ** 2
            y = -self.height * .25 * wave ** 2
        elif self.kind == 'float':
            x = self.travel * math.sin(2 * math.pi * t)
            y = -self.height * wave ** 2
        else:
            x = self.travel * wave
            y = -self.height * 4 * t * (1 - t)
        return round(self.origin[0] + x), round(self.origin[1] + y)

    @classmethod
    def within(cls, kind, origin, size, area, rng):
        x, y = origin
        left = max(0, x - area.left())
        right = max(0, area.right() + 1 - size.width() - x)
        up = max(0, y - area.top())
        direction = rng.choice([-1, 1])
        if (left if direction < 0 else right) < 12:
            direction = -direction
        room = min(left, right) if kind in ('double-hop', 'float') else (left if direction < 0 else right)
        travel = direction * min(room, 72 if kind == 'dash' else 36)
        return cls(kind, origin, travel, min(up, 52),
                   {'hop': 1.1, 'double-hop': 1.9, 'dash': 1.35, 'float': 2.6}[kind])


@dataclass(frozen=True)
class ClipMotion:
    """只在素材有效运动段单向位移；起步/收尾固定，结束保留新位置。"""
    origin: tuple
    travel: float
    height: float
    duration: float
    move_start: float
    move_stop: float
    manual: bool = False
    kind: str = 'clip'
    settle_height: float = 0.
    released: bool = False
    settle_duration: float = 1.15

    def position(self, progress):
        elapsed = max(0., min(1., progress)) * self.duration
        if self.released:
            t = min(1., elapsed / self.settle_duration)
            friction = (1. - math.exp(-6. * t)) / (1. - math.exp(-6.))
            rise = 0.
            phases = ((0., .42, 1.), (.42, .73, .56), (.73, 1., .3))
            for start, end, scale in phases:
                if start <= t < end:
                    u = (t - start) / (end - start)
                    rise = self.settle_height * scale * 4. * u * (1. - u)
                    break
            return round(self.origin[0] + self.travel * friction), round(self.origin[1] - rise)
        t = max(0., min(1., (elapsed - self.move_start) / (self.move_stop - self.move_start)))
        smooth = t * t * (3 - 2 * t)
        rise = self.height * math.sin(math.pi * t) ** 2
        return round(self.origin[0] + self.travel * smooth), round(self.origin[1] - rise)


@dataclass
class ReleaseSpring:
    """屏幕尺度的抛掷轨迹：重力积分、上下边界反弹与逐次能量衰减。"""
    x: float
    y: float
    vx: float
    vy: float
    left: float
    right: float
    top: float
    bottom: float
    gravity: float = 1600.
    restitution: float = .78
    settled: bool = False
    bounces: int = 0
    top_bounces: int = 0
    bottom_bounces: int = 0
    elapsed: float = 0.
    _remainder: float = 0.
    _finish_at: float | None = None
    _finish_y: float = 0.
    _finish_bottom: float = 0.

    STEP = 1. / 240.
    REST_SPEED = 72.

    @classmethod
    def launch(cls, origin, velocity, bounds):
        x, y = origin
        left, top, right, bottom = bounds
        gravity = 1600.
        right, bottom = max(left, right), max(top, bottom)
        span = max(1., bottom - top)
        speed = math.hypot(*velocity)
        strength = max(0., min(1., (speed - 280.) / 920.))
        # 轻甩短、重甩高；不再用屏高乘2.2强行把所有甩动抬到相同高度。
        height = min(span * .85, max(18., span * (.08 + .67 * strength)))
        vertical_speed = math.sqrt(2. * gravity * height)
        upward = velocity[1] <= 0 or abs(velocity[1]) < 80.
        vertical = -vertical_speed if upward else vertical_speed
        return cls(float(x), float(y), max(-1200., min(1200., velocity[0])), vertical,
                   float(left), float(right), float(top), float(bottom), gravity,
                   .46 + .20 * strength)

    def advance(self, seconds):
        if self.settled or seconds <= 0:
            return
        remaining = min(float(seconds), 12.) + self._remainder
        steps = int(remaining / self.STEP)
        self._remainder = remaining - steps * self.STEP
        for _ in range(steps):
            dt = self.STEP
            self.elapsed += dt
            if self.elapsed >= 8.:
                # 兜底在预算内平滑收敛，禁止12秒时从半空直接写到底部。
                if self._finish_at is None or self._finish_bottom != self.bottom:
                    self._finish_at = self.elapsed
                    self._finish_y, self._finish_bottom = self.y, self.bottom
                u = min(1., (self.elapsed - self._finish_at) / 1.2)
                eased = u * u * (3. - 2. * u)
                self.y = self._finish_y + (self.bottom - self._finish_y) * eased
                self.vy = (self.bottom - self._finish_y) * 6. * u * (1. - u) / 1.2
                self.vx *= math.exp(-4. * dt)
                self.x = max(self.left, min(self.right, self.x + self.vx * dt))
                if u >= 1.:
                    self.vx = self.vy = 0.
                    self.settled = True
                    break
                continue
            self.vy += self.gravity * dt
            self.x += self.vx * dt
            self.y += self.vy * dt
            self.vx *= math.exp(-1.25 * dt)
            if self.x < self.left:
                self.x = self.left
                self.vx = abs(self.vx) * self.restitution
            elif self.x > self.right:
                self.x = self.right
                self.vx = -abs(self.vx) * self.restitution
            if self.y < self.top:
                self.y = self.top
                self.vy = abs(self.vy) * self.restitution
                self.bounces += 1
                self.top_bounces += 1
            elif self.y > self.bottom:
                self.y = self.bottom
                impact = abs(self.vy)
                self.bounces += 1
                self.bottom_bounces += 1
                if impact * self.restitution < self.REST_SPEED:
                    self.vy = 0.
                    self.settled = True
                else:
                    self.vy = -impact * self.restitution
            if self.settled:
                break

    def position(self):
        return round(self.x), round(self.y)

    def update_bounds(self, bounds):
        """Adapt a live trajectory to screen/work-area changes without teleporting."""
        left, top, right, bottom = map(float, bounds)
        right = max(left, right)
        bottom = max(top, bottom)
        self.left, self.right, self.top, self.bottom = left, right, top, bottom
        # Dock 隐藏或切换屏幕后地面下移，不能在旧地面悬停。
        if self.settled and self.y < bottom:
            self.settled = False
            self.vy = 0.
        if self.x < left:
            self.x = left
            self.vx = abs(self.vx) * self.restitution
        elif self.x > right:
            self.x = right
            self.vx = -abs(self.vx) * self.restitution
        if self.y < top:
            self.y = top
            self.vy = abs(self.vy) * self.restitution
            self.bounces += 1
            self.top_bounces += 1
        elif self.y > bottom:
            self.y = bottom
            impact = abs(self.vy)
            self.bounces += 1
            self.bottom_bounces += 1
            if impact * self.restitution < self.REST_SPEED:
                self.vy = 0.
                self.settled = True
            else:
                self.vy = -impact * self.restitution


class AutonomousBehavior:
    # Short enough to make the expanded idle/movement library visible while
    # retaining a long quiet window during real work.
    INTERVAL = (12., 24.)
    KINDS = ('hop', 'double-hop', 'dash', 'float')
    RELEASE_MIN_SPEED = 280.
    RELEASE_MIN_DISTANCE = 24.
    DRAG_PROFILE_INTERVAL = .05
    DRAG_REST_SPEED = 80.
    DRAG_STOP_INTERVAL = .08
    MOTION_MAX_STEP = .05  # GUI 卡顿后不追赶积压位移。

    def __init__(self, pet, clock=time.monotonic, rng=None, reduce_motion=None):
        self.pet = pet
        self.clock = clock
        self.rng = rng or random.Random()
        self.reduce_motion = reduce_motion or reduced_motion
        self.enabled = pet.settings.value('autonomousEnabled', True, type=bool)
        self.motion_enabled = pet.settings.value('autonomousMotion', True, type=bool)
        self.motion = None
        self.motion_started = None
        self.motion_requested = None
        self.release_spring = None
        self.release_tick_at = None
        self.release_facing = None
        self.own_play = False
        self.last_action = None
        self.last_kind = None
        self.action_queue = []
        self.next_at = self.clock() + self.rng.uniform(*self.INTERVAL)
        self._motion_setting = True  # Fail closed until the first read.
        self._check_motion_at = 0.
        self.closed = False
        self.drag_samples = deque(maxlen=64)
        self.drag_item = None
        self.drag_facing = 'right'
        self.drag_origin = None
        self.drag_distance = 0.
        self.drag_profile_at = 0.

    def defer(self):
        self.next_at = self.clock() + self.rng.uniform(*self.INTERVAL)

    def interrupt(self):
        # 保留当前位置，按下鼠标或隐藏时不突然弹回起点。
        self.motion = None
        self.motion_started = None
        self.motion_requested = None
        self.release_spring = None
        self.release_tick_at = None
        self.release_facing = None
        self.defer()

    def on_play(self, mode):
        if not self.own_play and mode != 'idle':
            self.interrupt()

    def set_enabled(self, enabled):
        self.enabled = bool(enabled)
        self.pet.settings.setValue('autonomousEnabled', self.enabled)
        self.pause()

    def set_motion_enabled(self, enabled):
        self.motion_enabled = bool(enabled)
        self.pet.settings.setValue('autonomousMotion', self.motion_enabled)
        self.pause()

    def pause(self):
        moving = self.motion is not None
        self.interrupt()
        if moving and self.pet.mode == 'autonomous-motion':
            self._play(self.pet.idles[0], 'idle')

    def _play(self, item, mode, start_ms=0):
        self.own_play = True
        try:
            self.pet.play(item, mode, start_ms=start_ms)
        finally:
            self.own_play = False

    def action_pool(self):
        """日常静默轮询仅包含待机与互动差分。"""
        seen = set()
        result = []
        for item in self.pet.variants + self.pet.idles:
            identifier = item.get('id')
            if identifier and identifier not in seen:
                seen.add(identifier)
                result.append(item)
        return result

    def next_action(self, previous=None):
        """轮转完整动作池，避免随机抽样长期遗漏某个互动差分。"""
        pool = self.action_pool()
        identifiers = {item.get('id') for item in pool}
        if not pool:
            self.action_queue = []
            return None
        if not self.action_queue or any(item.get('id') not in identifiers for item in self.action_queue):
            self.action_queue = pool[:]
            self.rng.shuffle(self.action_queue)
        available = [item for item in self.action_queue
                     if item.get('id') not in (previous, self.last_action)]
        if not available:
            available = [item for item in self.action_queue if item.get('id') != previous] or self.action_queue
        item = available[0]
        self.action_queue.remove(item)
        return item

    def blocked(self, moving=False, allow_pointer=False, allow_disabled=False, allow_action=False):
        pet = self.pet
        return (self.closed or (not self.enabled and not allow_disabled) or pet.desktop_hidden() or not pet.isVisible()
                or pet.dragging or pet.task_active or pet.quota_inflight
                or pet.click_timer.isActive() or pet.bubble.isVisible()
                or QApplication.activePopupWidget() is not None
                or QApplication.activeModalWidget() is not None
                or bool(QApplication.mouseButtons())
                or (not moving and pet.mode != 'idle' and not allow_action)
                or (not moving and not allow_pointer and pet.frameGeometry().adjusted(-32, -32, 32, 32).contains(QCursor.pos())))

    def motion_reduced(self):
        now = self.clock()
        if now >= self._check_motion_at:
            try:
                self._motion_setting = bool(self.reduce_motion())
            except Exception:
                self._motion_setting = True
            self._check_motion_at = now + 2.
        return self._motion_setting

    def advance_release(self, spring, seconds):
        screen = QApplication.screenAt(self.pet.frameGeometry().center()) or QApplication.primaryScreen()
        if screen is None:
            self.pause()
            return False
        area = screen.availableGeometry()
        spring.update_bounds((area.left(), area.top(),
                              area.right() + 1 - self.pet.width(),
                              area.bottom() + 1 - self.pet.height()))
        spring.advance(seconds)
        position = QPoint(*spring.position())
        safe = self.pet.constrained_position(position, QPoint(*self.motion.origin) + self.pet.rect().center())
        if safe != position:
            self.pet.move(safe)
            self.pause()
            return False
        self.pet.move(position)
        return True

    def tick(self):
        if self.closed:
            return
        now = self.clock()
        if self.pet.dragging and self.pet.mode == 'drag':
            self.update_drag()
            return
        if self.motion:
            if self.blocked(moving=True, allow_disabled=self.motion.kind == 'settle' or getattr(self.motion, 'manual', False)) or (not self.motion_enabled and not getattr(self.motion, 'manual', False)) or self.motion_reduced():
                self.pause()
                return
            spring = self.release_spring
            if spring is not None:
                # 窗口物理不等待 WebP、姿态混合或动画换片；每个GUI tick只消费
                # 有上限的单调时钟增量，卡顿/恢复后绝不追赶一大段位移。
                previous = self.release_tick_at
                self.release_tick_at = now
                delta = 0. if previous is None else max(0., min(self.MOTION_MAX_STEP, now - previous))
                if not self.advance_release(spring, delta):
                    return
                # 水平反弹只更新绘制朝向，不换文件、不重启姿态或物理时钟。
                if abs(spring.vx) >= 60.:
                    self.release_facing = 'right' if spring.vx > 0 else 'left'
                if spring.settled:
                    self.motion = None
                    self.release_spring = None
                    self.release_tick_at = None
                    self.release_facing = None
                    self.defer()
                    self._play(self.pet.idles[0], 'idle')
                    return
                # 奔跑/飞行姿态循环到弹簧收敛；不按素材原时长提前回待机。
                return
            if self.pet.waiting_first_frame:
                if now - self.motion_requested > 5.:
                    self.pause()
                return
            if self.motion_started is None:
                self.motion_started = now
            # Clip time is the player's first-frame clock, not the time the file was requested.
            elapsed = self.pet.presentation_elapsed(now) if self.motion.kind == 'clip' else now - self.motion_started
            progress = elapsed / self.motion.duration
            position = QPoint(*self.motion.position(progress))
            safe = self.pet.constrained_position(position, QPoint(*self.motion.origin) + self.pet.rect().center())
            if safe != position:  # 屏幕移除、菜单栏/Dock 可用区域变化，立即终止轨迹。
                self.pet.move(safe)
                self.pause()
                return
            self.pet.move(position)
            if progress >= 1.:
                clip = self.motion.kind == 'clip'
                released = getattr(self.motion, 'released', False)
                self.interrupt()
                if clip:
                    if released:
                        self._play(self.pet.idles[0], 'idle')
                        return
                    self._play(self.pet.idles[0], 'idle')
                    return
                landing = self.pet.manifest.get('landingAnimation')
                self._play(landing or self.pet.idles[0], 'landing' if landing else 'idle')
            return
        if now < self.next_at:
            return
        if self.blocked() or self.pet.waiting_first_frame or self.motion_reduced():
            self.defer()
            return
        self.perform()

    def perform(self, preview=False):
        """仅复用动画，不调用 choose/quota/聊天/声音；预览也遵守任务与交互保护。"""
        if (self.blocked(allow_pointer=preview, allow_disabled=preview, allow_action=preview)
                or (self.pet.waiting_first_frame and not preview) or self.motion_reduced()):
            self.defer()
            return False
        self.defer()
        if self.motion_enabled and (preview or self.rng.random() < .45):
            if self.pet.manifest.get('movementAnimations'):
                return self.perform_movement(preview=preview)
            kinds = [kind for kind in self.KINDS if kind != self.last_kind]
            kind = self.rng.choice(kinds)
            screen = QApplication.screenAt(self.pet.frameGeometry().center()) or QApplication.primaryScreen()
            if screen:
                motion = Motion.within(kind, (self.pet.x(), self.pet.y()), self.pet.size(),
                                       screen.availableGeometry(), self.rng)
                if motion.height >= 8 or abs(motion.travel) >= 8:
                    item = self.pet.manifest.get('dragAnimation') or self.pet.idles[0]
                    self._play(item, 'autonomous-motion')
                    self.motion = motion
                    self.motion_requested = self.clock()
                    self.last_kind = kind
                    return True
        return self.perform_action(preview=preview)

    def _perform_action_unchecked(self):
        previous = self.pet.current.get('id') if self.pet.current else None
        item = self.next_action(previous)
        if item is None:
            return False
        self.last_action = item['id']
        self._play(item, 'variant')
        return True

    def perform_action(self, preview=False):
        """手动“表演一套动作”只选动作池，不误触发移动轨迹。"""
        if (self.blocked(allow_pointer=preview, allow_disabled=preview, allow_action=preview)
                or (self.pet.waiting_first_frame and not preview) or self.motion_reduced()):
            self.defer()
            return False
        self.defer()
        return self._perform_action_unchecked()

    def perform_movement(self, item=None, preview=False, *, released=False, velocity=(0., 0.)):
        """菜单只增加动作入口，定时调用静默；任务和减少动态效果始终优先。"""
        if (self.blocked(moving=preview, allow_pointer=preview, allow_disabled=preview, allow_action=preview) or
                (self.pet.waiting_first_frame and not (preview or released)) or
                (not self.motion_enabled and not preview) or self.motion_reduced()):
            self.defer()
            return False
        pool = self.pet.manifest.get('movementAnimations', [])
        if item is not None and item not in pool:
            return False
        screen = QApplication.screenAt(self.pet.frameGeometry().center()) or QApplication.primaryScreen()
        if screen is None:
            return False
        area = screen.availableGeometry()
        left = max(0, self.pet.x() - area.left())
        right = max(0, area.right() + 1 - self.pet.width() - self.pet.x())
        candidates = [v for v in ([item] if item else pool)
                      if released or preview or (left if v.get('sourceFacing') == 'left' else right) >= 12]
        other = [v for v in candidates if v['id'] != self.last_action]
        if not candidates:
            self.defer()
            return False
        item = item if item is not None else self.rng.choice(other or candidates)
        if released:
            item = release_clip(item, self.pet.asset_path({'file': 'dragon-release/catalog.json'}))
        duration = item.get('durationMs', 0) / 1000
        start, stop = item.get('moveStartMs', -1) / 1000, item.get('moveStopMs', -1) / 1000
        if not 0 <= start < stop <= duration or item.get('sourceFacing') not in ('left', 'right'):
            return False
        facing = item['sourceFacing']
        room = left if facing == 'left' else right
        flying = item['id'].startswith('move03')
        if flying:
            cap = min(640, max(300, round(area.width() * .34)))
        elif item['id'].startswith('move02'):
            cap = min(520, max(240, round(area.width() * .27)))
        else:
            cap = min(420, max(160, round(area.width() * .18)))
        travel = min(room, cap) * (-1 if facing == 'left' else 1)
        flight_height = min(280, max(112, round(area.height() * .22)))
        height = min(max(0, self.pet.y() - area.top()), flight_height) if flying else 0
        entry = 0.
        if released:
            # Reuse the visible drag frame when possible; distant sequential frames
            # can otherwise delay the release while the decoder catches up.
            entry = max(0., start - .2)
            clock = self.pet.presentation
            if self.pet.current is item and clock is not None:
                entry = max(entry, min(stop - .001, clock.offset + clock.elapsed))
            travel = min(room, 160., abs(velocity[0]) * .18) * (-1 if facing == 'left' else 1)
            height = min(max(0, self.pet.y() - area.top()), 30. + min(math.hypot(*velocity) * .012, 28.))
        self._play(item, 'autonomous-motion', start_ms=entry * 1000)
        # 松手只循环有效运动段；停止/疲惫收尾不属于拖拽反馈。
        clip_duration = (stop if released else duration) - entry
        self.motion = ClipMotion((self.pet.x(), self.pet.y()), travel, height,
                                 clip_duration, start - entry, stop - entry, preview,
                                 settle_height=height if released else 0., released=released)
        if released:
            self.release_facing = facing
            self.pet.presentation.set_loop(start, stop)
            bounds = (area.left(), area.top(), area.right() + 1 - self.pet.width(),
                      area.bottom() + 1 - self.pet.height())
            self.release_spring = ReleaseSpring.launch(
                (self.pet.x(), self.pet.y()), velocity, bounds)
            self.release_tick_at = self.clock()
        self.motion_started = None
        self.motion_requested = self.clock()
        self.last_action = item['id']
        self.defer()
        return True

    def begin_drag(self):
        self.pause()
        self.drag_samples.clear()
        self.drag_item = None
        self.drag_origin = (self.pet.x(), self.pet.y())
        self.drag_distance = 0.
        self.drag_profile_at = 0.
        self.record_drag()

    def record_drag(self):
        x, y = self.pet.x(), self.pet.y()
        self.drag_samples.append((self.clock(), x, y))
        if self.drag_origin is not None:
            self.drag_distance = max(self.drag_distance,
                                     math.hypot(x - self.drag_origin[0], y - self.drag_origin[1]))

    def drag_velocity(self, window, now=None):
        """Use a time window, including time held still before release."""
        now = self.clock() if now is None else now
        samples = [sample for sample in self.drag_samples if 0 <= now - sample[0] <= window]
        if len(samples) < 2 or now - samples[-1][0] >= self.DRAG_STOP_INTERVAL:
            return 0., 0.
        dt = now - samples[0][0]
        if dt < .008:
            return 0., 0.
        return ((samples[-1][1] - samples[0][1]) / dt,
                (samples[-1][2] - samples[0][2]) / dt)

    def drag_animation(self):
        """轻拖用普通姿态，明显位移才走/跑/飞；阈值滞回避免反复解码。"""
        now = self.clock()
        if self.drag_item is not None and now - self.drag_profile_at < self.DRAG_PROFILE_INTERVAL:
            return self.drag_item
        vx, vy = self.drag_velocity(.2, now)
        speed = math.hypot(vx, vy)
        previous = (self.drag_item or {}).get('id', '')
        rest_speed = 60. if previous.startswith('move') else self.DRAG_REST_SPEED
        item = self.pet.idles[0]
        pool = self.pet.manifest.get('movementAnimations', [])
        if speed >= rest_speed and not self.motion_reduced():
            if not pool:
                item = self.pet.manifest.get('dragAnimation') or item
            else:
                flying = previous.startswith('move03')
                running = previous.startswith('move02')
                if (abs(vy) >= (150. if flying else 180.)
                        and speed >= (230. if flying else self.RELEASE_MIN_SPEED)
                        and abs(vy) > abs(vx) * (.6 if flying else .75)):
                    kind = 'move03'
                elif abs(vx) >= (480. if running else 600.):
                    kind = 'move02'
                else:
                    kind = 'move01'
                if abs(vx) >= 35:
                    self.drag_facing = 'left' if vx < 0 else 'right'
                item = next((v for v in pool if v['id'].startswith(kind) and
                             v.get('sourceFacing') == self.drag_facing), None)
                item = item or next((v for v in pool if v['id'].startswith(kind)), None) or self.pet.idles[0]
        self.drag_item = item
        self.drag_profile_at = now
        return item

    def update_drag(self):
        """拖动只循环有效运动段，跳过站立准备及停止/疲惫收尾。"""
        item = self.drag_animation()
        clock = self.pet.presentation
        movement = item in self.pet.manifest.get('movementAnimations', [])
        end = item.get('moveStopMs', item.get('durationMs', 0)) / 1000.
        restart = (clock is not None and not clock.waiting
                   and (clock.finished or (movement and clock.offset + clock.elapsed >= end)))
        if item is not self.pet.current or self.pet.mode != 'drag' or restart:
            start_ms = item.get('moveStartMs', 0) if movement else 0
            self.pet.play(item, 'drag', start_ms=start_ms)

    def release_drag(self):
        """只处理窗口动量，无鼠标合成、碰撞扫描或桌面内容读取。"""
        self.defer()
        self.drag_item = None
        if self.blocked(moving=True, allow_disabled=True) or not self.motion_enabled or self.motion_reduced():
            return False
        now = self.clock()
        samples = [sample for sample in self.drag_samples if 0 <= now - sample[0] <= .15]
        vx, vy = self.drag_velocity(.15, now)
        distance = self.drag_distance
        if distance == 0. and len(samples) >= 2:
            distance = math.hypot(samples[-1][1] - samples[0][1],
                                  samples[-1][2] - samples[0][2])
        # A release animation is a deliberate flick, not a side effect of moving
        # the window. Gentle drags remain at the dropped position without a hop.
        if distance < self.RELEASE_MIN_DISTANCE or math.hypot(vx, vy) < self.RELEASE_MIN_SPEED:
            return False
        movements = self.pet.manifest.get('movementAnimations', [])
        if movements:
            facing = self.drag_facing if abs(vx) < 35 else ('left' if vx < 0 else 'right')
            # 每次明确甩动仅随机一次：奔跑追羽毛 / 飞行；方向仍跟随松手。
            # 素材包缺少其中一类时从可用动作中选，不回退到走路或疲惫收尾。
            candidates = [v for v in movements
                          if v['id'].startswith(('move02', 'move03'))
                          and v.get('sourceFacing') == facing
                          and 0 <= v.get('moveStartMs', -1) < v.get('moveStopMs', -1)
                          <= v.get('durationMs', 0)]
            if not candidates:
                return False
            item = self.rng.choice(candidates)
            # 最新松手指令取代仍在解码的拖拽帧；不排队播放旧动作。
            return self.perform_movement(item, preview=True, released=True, velocity=(vx, vy))
        velocity = vx
        screen = QApplication.screenAt(self.pet.frameGeometry().center()) or QApplication.primaryScreen()
        if screen is None:
            return False
        area = screen.availableGeometry()
        origin = self.pet.constrained_position(self.pet.pos(), self.pet.frameGeometry().center())
        self.pet.move(origin)
        low = area.left() - origin.x()
        high = max(area.left(), area.right() + 1 - self.pet.width()) - origin.x()
        travel = max(low, min(high, max(-96., min(96., velocity * .16))))
        height = min(max(0, origin.y() - area.top()), 34. + min(abs(velocity) * .012, 18.))
        if height < 4 and abs(travel) < 4:
            return False
        self._play(self.pet.idles[0], 'autonomous-motion')
        self.motion = Motion('settle', (origin.x(), origin.y()), travel, height, 1.25)
        self.motion_started = None
        self.motion_requested = now
        return True

    def close(self):
        self.closed = True
        self.interrupt()
