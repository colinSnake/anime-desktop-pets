import type { PreviewBridge } from './bridge';
import { type Clip, clipSource, createClipSwitcher, isFullMovement } from './playback';
import { keepSegment, prepareFirstFrame } from './video-segment';
import type { Facing } from './locomotion';
import { createQuotaCard } from './quota-card';
import { bounceBlendMs, createPoseBlend, dragBlendMs, drawVideo, loopBlendMs } from './pose-blend';
import { companionHost } from './video-role';
import { companionRect, nominalSize, poseRect } from './pose-geometry';

declare global { interface Window { petVideoPreview: PreviewBridge } }
const bridge = window.petVideoPreview;
const layers = Array.from(document.querySelectorAll('video'));
const status = document.querySelector('output')!;
const nameBubble = document.querySelector<HTMLElement>('#pet-name')!;
const companion = location.hostname === companionHost;
if (companion) {
  nameBubble.textContent = '大肥鱼';
  document.querySelector('main')!.setAttribute('aria-label', '大肥鱼 · 视频桌宠');
}
let visible: HTMLVideoElement | undefined;
let shown: { clip: Clip; generation: number } | undefined;
let requested: { clip: Clip; generation: number; facing?: Facing; blend: number } | undefined;
let stopSegment: (() => void) | undefined;
let mirrored = false;
const mediaTimes = new WeakMap<HTMLVideoElement, number>();
let heldPointer: number | undefined;
let lastPoint: { x: number; y: number } | undefined;
let lastHit = false;
let petHit = false;
let press: { x: number; y: number; moved: boolean } | undefined;
let cleanReleases = 0;
let menuOpen = false;
const caption = document.querySelector<HTMLElement>('#pet-caption')!;
let captionToken: number | undefined;
bridge.onCaption(state => {
  captionToken = state?.token;
  caption.textContent = state?.text ?? '';
  caption.hidden = !state;
  if (!state) return;
  // Acknowledge after a paint opportunity, never at the time of the incoming request.
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (captionToken === state.token && !caption.hidden && !document.hidden) bridge.captionShown(state.token);
  }));
});
const mask = document.createElement('canvas');
mask.width = mask.height = 96;
const ctx = mask.getContext('2d', { willReadFrequently: true });
const quotaCard = createQuotaCard(bridge, probeHit);
const overlay = document.querySelector<HTMLCanvasElement>('#pet-pose')!;
const transition = createPoseBlend(overlay);

function paintPose(ctx: CanvasRenderingContext2D, edge: number) {
  if (!visible || !shown) return;
  const size = nominalSize(window.innerWidth);
  const { x, y, width, height = width } = companion ? companionRect(size) : poseRect(shown.clip, size, mediaTimes.get(visible) ?? 0, mirrored);
  const ratio = edge / window.innerWidth;
  drawVideo(ctx, visible, { x: x * ratio, y: y * ratio, width: width * ratio, height: height * ratio, mirrored });
}
function placePose() {
  if (!visible || !shown) return;
  const size = nominalSize(window.innerWidth);
  const { x, y, width, height = width } = companion ? companionRect(size) : poseRect(shown.clip, size, mediaTimes.get(visible) ?? 0, mirrored);
  visible.style.left = `${x}px`;
  visible.style.top = `${y}px`;
  visible.style.width = `${width}px`;
  visible.style.height = `${height}px`;
}

let pixels: Uint8ClampedArray | undefined;
function refreshMask() {
  pixels = undefined;
  if (!ctx || !visible || !lastPoint || heldPointer !== undefined || menuOpen) return;
  try {
    ctx.clearRect(0, 0, mask.width, mask.height);
    if (!overlay.hidden) ctx.drawImage(overlay, 0, 0, mask.width, mask.height);
    else paintPose(ctx, mask.width);
    pixels = ctx.getImageData(0, 0, mask.width, mask.height).data;
  } catch { /* Failed alpha sampling stays click-through. */ }
}

function paintName(hit: boolean) {
  const point = lastPoint;
  if (!hit || !point || menuOpen || heldPointer !== undefined) { nameBubble.hidden = true; return; }
  nameBubble.hidden = false;
  const beside = (position: number, size: number, limit: number) => {
    const next = position + 12;
    return Math.max(0, Math.min(limit - size, next + size <= limit ? next : position - size - 8));
  };
  const x = beside(point.x, nameBubble.offsetWidth, window.innerWidth);
  const y = beside(point.y, nameBubble.offsetHeight, window.innerHeight);
  nameBubble.style.transform = `translate(${x}px, ${y}px)`;
}

function probeHit() {
  if (heldPointer !== undefined) return;
  let hit = false;
  if (!menuOpen && pixels && lastPoint) {
    const x = Math.floor(lastPoint.x * mask.width / window.innerWidth);
    const y = Math.floor(lastPoint.y * mask.height / window.innerHeight);
    if (x >= 0 && y >= 0 && x < mask.width && y < mask.height) {
      hit = (pixels[(y * mask.width + x) * 4 + 3] ?? 0) >= 32;
    }
  }
  const cardHit = !menuOpen && !!lastPoint && quotaCard.contains(lastPoint);
  petHit = hit && !cardHit;
  paintName(petHit);
  document.body.toggleAttribute('data-hit', petHit);
  hit ||= cardHit;
  if (hit === lastHit) return;
  lastHit = hit;
  bridge.hit(hit);
}

function sampleHover() { refreshMask(); probeHit(); }

function updateFace() {
  if (!visible || !shown || requested?.generation !== shown.generation) return;
  const native = clipSource(shown.clip).facing;
  mirrored = !!requested.facing && !!native && requested.facing !== native;
  visible.classList.toggle('mirrored', mirrored);
  placePose();
}

const player = createClipSwitcher({
  prepare(slot, clip, signal) {
    const target = layers[slot]!;
    return prepareFirstFrame(target, clip, signal, mediaMs => mediaTimes.set(target, mediaMs));
  },
  reveal(slot, clip, generation) {
    stopSegment?.();
    visible = layers[slot]!;
    shown = { clip, generation };
    updateFace();
    for (const [index, layer] of layers.entries()) {
      layer.classList.toggle('visible', index === slot);
      if (index !== slot) layer.pause();
    }
    const target = visible;
    const failed = () => bridge.frame('failed', clip, generation);
    const resume = () => { if (target.paused) void target.play().catch(failed); sampleHover(); };
    const source = clipSource(clip);
    const followGeometry = source.file === 'move03left';
    const followTravel = isFullMovement(clip);
    const play = () => {
      if (source.range || followGeometry || followTravel) stopSegment = keepSegment(target, clip, failed, {
        frame(mediaMs) {
          mediaTimes.set(target, mediaMs);
          if (followGeometry) placePose();
          if (followTravel && requested?.generation === generation) bridge.travelFrame(generation, mediaMs);
        },
        seamStart(legalTail) {
          if (legalTail) transition.freeze(paintPose);
        },
        seamEnd() {
          if (overlay.hidden || reduce.matches) { transition.clear(); sampleHover(); return; }
          target.pause();
          transition.blend(loopBlendMs, paintPose, resume);
        },
      });
      resume();
    };
    const blend = requested?.blend ?? 0;
    if (!overlay.hidden) {
      target.pause();
      transition.blend(reduce.matches ? 0 : blend, paintPose, play);
    } else play();
    status.hidden = true;
    bridge.frame('shown', clip, generation);
    sampleHover();
  },
  fail(clip, generation) {
    status.hidden = false;
    status.textContent = '预览片段未能播放。可从菜单重试或退出。';
    bridge.frame('failed', clip, generation);
  },
});
for (const [slot, layer] of layers.entries()) {
  layer.addEventListener('ended', () => {
    if (!layer.ended || layer !== visible) return;
    const result = player.onEnded(slot);
    if (result) bridge.frame('ended', result.clip, result.generation);
  });
  layer.addEventListener('error', () => {
    if (layer === visible && shown) bridge.frame('failed', shown.clip, shown.generation);
  });
}
bridge.onAction((clip, generation) => {
  if (requested && generation <= requested.generation) return;
  let blend = 0;
  if (visible && shown && shown.clip !== clip) {
    const duration = dragBlendMs(shown.clip, clip, reduce.matches);
    if ((duration || !overlay.hidden) && transition.freeze(paintPose)) {
      visible.pause();
      stopSegment?.();
      stopSegment = undefined;
      blend = duration;
    }
  }
  requested = { clip, generation, facing: clipSource(clip).facing, blend };
  void player.show(clip, generation);
});
bridge.onFace((generation, facing) => {
  if (requested?.generation !== generation) return;
  requested.facing = facing;
  const nativeFacing = shown && clipSource(shown.clip).facing;
  const duration = shown?.generation === generation && visible && nativeFacing
    ? bounceBlendMs(shown.clip, mirrored, facing !== nativeFacing, reduce.matches, visible.seeking || !overlay.hidden) : 0;
  const frozen = duration && transition.freeze(paintPose);
  updateFace();
  if (frozen) transition.blend(duration, paintPose, sampleHover);
  sampleHover();
});
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const syncReduce = () => { if (reduce.matches) transition.reduce(); bridge.reducedMotion(reduce.matches); };
reduce.addEventListener('change', syncReduce);
let hitTimer: number | undefined;
// Electron forwards mousemove/leave while the transparent window passes clicks through.
function followPoint(x: number, y: number) {
  lastPoint = { x, y };
  if (hitTimer === undefined) {
    refreshMask();
    hitTimer = window.setInterval(sampleHover, 80);
  }
  probeHit();
}
const pressDistance = (event: MouseEvent, point: { x: number; y: number }) =>
  Math.hypot(event.screenX - point.x, event.screenY - point.y);
window.addEventListener('mousemove', event => {
  if (press && pressDistance(event, press) > 5) press.moved = true;
  if (!menuOpen) followPoint(event.clientX, event.clientY);
});
function stopHover() {
  clearInterval(hitTimer);
  hitTimer = undefined;
  lastPoint = undefined;
  pixels = undefined;
  nameBubble.hidden = true;
  probeHit();
}
bridge.onMenuState((open, point) => {
  menuOpen = open;
  stopHover();
  if (!open && point) followPoint(point.x, point.y);
});
window.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (menuOpen || heldPointer !== undefined || (event.button !== 2 && !(event.button === 0 && event.ctrlKey))) return;
  lastPoint = { x: event.clientX, y: event.clientY };
  sampleHover();
  if (petHit) bridge.openMenu();
});
window.addEventListener('dblclick', event => {
  if (event.button !== 0 || event.ctrlKey || menuOpen || heldPointer !== undefined) return;
  lastPoint = { x: event.clientX, y: event.clientY };
  sampleHover();
  if (petHit && cleanReleases >= 2) bridge.requestQuota();
  cleanReleases = 0;
});
document.documentElement.addEventListener('mouseleave', stopHover);
window.addEventListener('pointerdown', event => {
  if (menuOpen || event.button !== 0 || event.ctrlKey || heldPointer !== undefined) return;
  lastPoint = { x: event.clientX, y: event.clientY };
  sampleHover();
  if (!petHit) { cleanReleases = 0; return; }
  press = { x: event.screenX, y: event.screenY, moved: false };
  document.body.setPointerCapture(event.pointerId);
  heldPointer = event.pointerId;
  nameBubble.hidden = true;
  document.body.toggleAttribute('data-drag', true);
  bridge.gesture('begin');
});
function clearPointer() {
  const pointer = heldPointer;
  heldPointer = undefined;
  press = undefined;
  if (pointer !== undefined && document.body.hasPointerCapture(pointer)) document.body.releasePointerCapture(pointer);
  document.body.toggleAttribute('data-drag', false);
  document.body.toggleAttribute('data-hit', false);
  lastHit = petHit = false;
}
function endDrag(event: PointerEvent, release: boolean) {
  if (event.pointerId !== heldPointer) return;
  cleanReleases = release && press && !press.moved && pressDistance(event, press) <= 5
    ? cleanReleases + 1 : 0;
  clearPointer();
  lastPoint = release ? { x: event.clientX, y: event.clientY } : undefined;
  bridge.gesture(release ? 'release' : 'cancel');
  // The preview main resets click-through on drag end. Refresh now, not on the next timer tick.
  sampleHover();
}
bridge.onDragReset(() => { cleanReleases = 0; clearPointer(); stopHover(); });
window.addEventListener('pointermove', event => {
  if (event.pointerId === heldPointer && (event.buttons & 1)) bridge.gesture('move');
});
window.addEventListener('pointerup', event => endDrag(event, true));
window.addEventListener('pointercancel', event => endDrag(event, false));
window.addEventListener('lostpointercapture', event => endDrag(event, false));
window.addEventListener('resize', () => { placePose(); sampleHover(); });
window.addEventListener('pagehide', () => {
  captionToken = undefined;
  bridge.closeQuota();
  stopHover(); player.close(); stopSegment?.(); transition.clear();
  reduce.removeEventListener('change', syncReduce);
});
syncReduce();
