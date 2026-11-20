/* TypeScript 同步版，参考 pet_release_physics.py。
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
*/
import type { Point, Sample } from './motion';

const maximumSpeed = 3600;
const step = 1 / 240;
const friction = 2.5;
export type Edges = { left: number; top: number; right: number; bottom: number };

export function estimateReleaseVelocity(trail: readonly Sample[], now: number): Point | undefined {
  const samples = trail.filter(p => [p.time, p.x, p.y].every(Number.isFinite) && now - p.time >= 0 && now - p.time <= 150);
  const first = samples[0], last = samples.at(-1);
  if (!first || !last || now - last.time >= 80 - 1e-6 || last.time - first.time < 20 - 1e-6) return;
  const seconds = (last.time - first.time) / 1000;
  const vx = (last.x - first.x) / seconds, vy = (last.y - first.y) / seconds;
  const base = Math.hypot(vx, vy);
  if (base < 280) return;
  let previous = first;
  const segments: { speed: number; time: number }[] = [];
  for (const sample of samples.slice(1)) {
    const dt = (sample.time - previous.time) / 1000;
    if (dt < .008 - 1e-9) continue;
    segments.push({ speed: Math.hypot(sample.x - previous.x, sample.y - previous.y) / dt, time: sample.time });
    previous = sample;
  }
  const peak = segments.length ? Math.max(...segments.map(segment => segment.speed)) : base;
  const accel = segments.length < 2 ? 0 : (segments.at(-1)!.speed - segments[0]!.speed) /
    Math.max(.02, (segments.at(-1)!.time - segments[0]!.time) / 1000);
  const raw = .5 * (base + peak) * (1 + Math.min(Math.max(accel, 0) / 8000, 1) * .6);
  const speed = -maximumSpeed * Math.expm1(-raw / maximumSpeed);
  if (speed >= 280) return { x: vx / base * speed, y: vy / base * speed };
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
const normalized = ({ left, top, right, bottom }: Edges): Edges => ({ left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) });
// Match Python round at exact half ties, including negative desktop coordinates.
const nearest = (value: number) => {
  const low = Math.floor(value);
  return value - low === .5 && low % 2 === 0 ? low : Math.round(value);
};

export class ReleaseSpring {
  x: number;
  y: number;
  vx: number;
  vy: number;
  settled = false;
  grounded = false;
  topBounces = 0;
  bottomBounces = 0;
  private remainder = 0;
  private bounds: Edges;

  constructor(origin: Point, velocity: Point, bounds: Edges) {
    this.bounds = normalized(bounds);
    this.x = clamp(origin.x, this.bounds.left, this.bounds.right);
    this.y = clamp(origin.y, this.bounds.top, this.bounds.bottom);
    const speed = Math.hypot(velocity.x, velocity.y);
    this.vx = speed > maximumSpeed ? velocity.x / speed * maximumSpeed : velocity.x;
    this.vy = speed > maximumSpeed ? velocity.y / speed * maximumSpeed : velocity.y;
  }

  private contact(nx: number, ny: number) {
    const vn = this.vx * nx + this.vy * ny;
    if (vn >= 0) return;
    const tx = -ny, ty = nx;
    const tangent = (this.vx * tx + this.vy * ty) * Math.max(0, 1 - friction * step);
    const normal = -vn < 40 ? 0 : -vn * .78;
    this.vx = normal * nx + tangent * tx;
    this.vy = normal * ny + tangent * ty;
    if (ny > 0) this.topBounces++;
    if (ny < 0) this.bottomBounces++;
  }

  advance(ms: number) {
    if (this.settled || !Number.isFinite(ms) || ms <= 0) return;
    const remaining = Math.min(ms / 1000, 12) + this.remainder;
    const steps = Math.floor((remaining + 1e-12) / step);
    this.remainder = Math.max(0, remaining - steps * step);
    for (let i = 0; i < steps; i++) {
      if (this.grounded) {
        this.y = this.bounds.bottom;
        this.vy = 0;
        this.vx *= Math.max(0, 1 - friction * step);
      } else this.vy += 1400 * step;
      this.x += this.vx * step;
      this.y += this.vy * step;
      this.confine(true);
      if (this.grounded && Math.abs(this.vx) < 15) {
        this.vx = this.vy = 0;
        this.settled = true;
        break;
      }
    }
  }

  setBounds(value: Edges) {
    this.bounds = normalized(value);
    if (this.y < this.bounds.bottom && (this.grounded || this.settled)) {
      this.grounded = this.settled = false;
      this.vy = 0;
    }
    this.confine(false);
  }

  private confine(advance: boolean) {
    const { left, right, top, bottom } = this.bounds;
    if (this.x < left) { this.x = left; this.contact(1, 0); }
    else if (this.x > right) { this.x = right; this.contact(-1, 0); }
    if (this.y < top) { this.y = top; this.contact(0, 1); }
    else if (this.y > bottom || (advance && this.y === bottom)) {
      this.y = bottom; this.contact(0, -1); this.grounded = this.vy === 0;
    }
  }

  position(): Point { return { x: nearest(this.x), y: nearest(this.y) }; }
}
