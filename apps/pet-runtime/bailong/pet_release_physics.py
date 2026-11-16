"""松手抛掷的纯物理：轨迹估速、合速度软限速、四面接触和固定步长积分。

Adapted from deepseek-pet/dsh-pet, src/shared/physics/{release,spring,throw,
contact,constants}.ts at 8ad3d957f83052d332f0d0f09e90993e9756d2ec.
Qt-specific adaptation: logical pixels, existing 80ms hold/280px/s gates,
fixed 240Hz substeps, and live single-screen work-area bounds.

MIT License

Copyright (c) 2026 PC2005-cloud

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
from dataclasses import dataclass
import math

MAX_THROW_SPEED = 3600.
RELEASE_WINDOW = .15
MIN_SPAN = .02
SEGMENT_MIN_SPAN = .008
DRAG_FRICTION = 4.  # Existing held-drag pose estimator; not airborne friction.


def estimate_release_velocity(trail, now, *, min_speed=280., stale_after=.08):
    """方向取首末位移；均速/峰值各半，末段加速最多增益60%，最后软限速。

    保留本项目停顿80ms即轻放的语义；异常/过短/无可靠方向的轨迹不抛。
    调用方另外检查累计拖拽距离，不能靠一个很短的抖动触发甩动。
    """
    samples = [sample for sample in trail
               if all(math.isfinite(v) for v in sample)
               and 0. <= now - sample[0] <= RELEASE_WINDOW]
    if len(samples) < 2 or now - samples[-1][0] >= stale_after - 1e-9:
        return None
    t0, x0, y0 = samples[0]
    t1, x1, y1 = samples[-1]
    span = t1 - t0
    if span < MIN_SPAN - 1e-9:
        return None
    vx, vy = (x1 - x0) / span, (y1 - y0) / span
    base_speed = math.hypot(vx, vy)
    # 不允许峰值/加速增益绕过原有最近150ms合速度下限。
    if base_speed < max(min_speed, 1e-6):
        return None
    segments = []
    pt, px, py = samples[0]
    for t, x, y in samples[1:]:
        dt = t - pt
        if dt >= SEGMENT_MIN_SPAN - 1e-9:
            segments.append((math.hypot(x - px, y - py) / dt, t))
            pt, px, py = t, x, y
    peak = max((speed for speed, _ in segments), default=base_speed)
    accel = 0.
    if len(segments) >= 2:
        accel = ((segments[-1][0] - segments[0][0]) /
                 max(segments[-1][1] - segments[0][1], MIN_SPAN))
    raw_speed = .5 * (base_speed + peak) * (1. + min(max(accel, 0.) / 8000., 1.) * .6)
    speed = -MAX_THROW_SPEED * math.expm1(-raw_speed / MAX_THROW_SPEED)
    if speed < min_speed:
        return None
    return vx / base_speed * speed, vy / base_speed * speed


@dataclass
class ReleaseSpring:
    """兼容既有调度接口的抛体；不读时钟、不碰Qt，也没有定时强制落底。"""
    x: float
    y: float
    vx: float
    vy: float
    left: float
    right: float
    top: float
    bottom: float
    gravity: float = 1400.
    restitution: float = .78
    settled: bool = False
    bounces: int = 0
    top_bounces: int = 0
    bottom_bounces: int = 0
    grounded: bool = False
    elapsed: float = 0.
    _remainder: float = 0.

    STEP = 1. / 240.
    REST_SPEED = 40.
    REST_TANGENT = 15.
    GROUND_FRICTION = 2.5

    @classmethod
    def launch(cls, origin, velocity, bounds):
        left, top, right, bottom = map(float, bounds)
        right, bottom = max(left, right), max(top, bottom)
        vx, vy = map(float, velocity)
        # 初速已在估速处软限速；这里只做合速度安全上限，绝不二次软压缩。
        speed = math.hypot(vx, vy)
        if speed > MAX_THROW_SPEED:
            vx, vy = vx / speed * MAX_THROW_SPEED, vy / speed * MAX_THROW_SPEED
        x, y = origin
        return cls(max(left, min(right, float(x))), max(top, min(bottom, float(y))),
                   vx, vy, left, right, top, bottom)

    def _contact(self, nx, ny, dt):
        """法向反弹、切向按时间摩擦；已离开接触面的速度不反向或减能。"""
        vn = self.vx * nx + self.vy * ny
        if vn >= 0.:
            return
        tx, ty = -ny, nx
        tangent = (self.vx * tx + self.vy * ty) * max(0., 1. - self.GROUND_FRICTION * dt)
        normal = 0. if -vn < self.REST_SPEED else -vn * self.restitution
        self.vx, self.vy = normal * nx + tangent * tx, normal * ny + tangent * ty
        if ny:
            self.bounces += 1
            if ny > 0:
                self.top_bounces += 1
            else:
                self.bottom_bounces += 1

    def advance(self, seconds):
        if self.settled or not math.isfinite(seconds) or seconds <= 0:
            return
        # GUI层另有50ms上限；这里保留批量离线推进，固定子步避免穿透/帧率差异。
        remaining = min(float(seconds), 12.) + self._remainder
        steps = int((remaining + 1e-12) / self.STEP)
        self._remainder = max(0., remaining - steps * self.STEP)
        for _ in range(steps):
            dt = self.STEP
            self.elapsed += dt
            if self.grounded:
                self.y, self.vy = self.bottom, 0.
                self.vx *= max(0., 1. - self.GROUND_FRICTION * dt)
            else:
                self.vy += self.gravity * dt
            self.x += self.vx * dt
            self.y += self.vy * dt
            if self.x < self.left:
                self.x = self.left
                self._contact(1., 0., dt)
            elif self.x > self.right:
                self.x = self.right
                self._contact(-1., 0., dt)
            if self.y < self.top:
                self.y = self.top
                self._contact(0., 1., dt)
            elif self.y >= self.bottom:
                self.y = self.bottom
                self._contact(0., -1., dt)
                self.grounded = self.vy == 0.
            if self.grounded and abs(self.vx) < self.REST_TANGENT:
                self.vx = self.vy = 0.
                self.settled = True
                break

    def position(self):
        return round(self.x), round(self.y)

    def update_bounds(self, bounds):
        """每步接收当前可用区域；扩展继续下落，收缩夹回并按同一接触模型处理。"""
        left, top, right, bottom = map(float, bounds)
        self.left, self.right = left, max(left, right)
        self.top, self.bottom = top, max(top, bottom)
        if self.y < self.bottom and (self.settled or self.grounded):
            self.settled = self.grounded = False
            self.vy = 0.
        if self.x < self.left:
            self.x = self.left
            self._contact(1., 0., self.STEP)
        elif self.x > self.right:
            self.x = self.right
            self._contact(-1., 0., self.STEP)
        if self.y < self.top:
            self.y = self.top
            self._contact(0., 1., self.STEP)
        elif self.y > self.bottom:
            self.y = self.bottom
            self._contact(0., -1., self.STEP)
            self.grounded = self.vy == 0.
