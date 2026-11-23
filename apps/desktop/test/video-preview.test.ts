import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clampPosition } from '../src/video-preview/motion.ts';
import { createClipSwitcher, type Clip } from '../src/video-preview/playback.ts';
import { previewResponse, previewURL } from '../src/video-preview/media.ts';

test('desktop edges account for the pet size and negative screen coordinates', () => {
  assert.deepEqual(clampPosition({ x: -900, y: 900 }, { width: 250, height: 250 },
    { x: -800, y: 25, width: 800, height: 600 }), { x: -800, y: 375 });
});

test('old clip remains visible until latest first frame; outdated readiness and end are ignored', async () => {
  const pending: { clip: Clip; slot: number; signal: AbortSignal; resolve: () => void; reject: () => void }[] = [];
  const swaps: string[] = [];
  const errors: Clip[] = [];
  const player = createClipSwitcher({ canReuse: () => true, prepare(slot, clip, signal) {
    return new Promise<void>((resolve, reject) => pending.push({ clip, slot, signal, resolve, reject: () => reject(new Error()) }));
  }, reveal: (slot, clip) => { swaps.push(`${slot}:${clip}`); }, fail: clip => { errors.push(clip); } });
  const idle = player.show('idle', 1);
  pending[0]!.resolve();
  await idle;
  const work = player.show('work', 2);
  assert.deepEqual(swaps, ['0:idle']);
  const drag = player.show('drag', 3);
  assert.equal(pending[1]!.signal.aborted, true);
  pending[1]!.resolve();
  await work;
  assert.deepEqual(swaps, ['0:idle']);
  pending[2]!.resolve();
  await drag;
  assert.deepEqual(swaps, ['0:idle', '1:drag']);
  assert.equal(player.onEnded(1), undefined);
  const release = player.show('release', 4);
  assert.equal(player.onEnded(1), undefined);
  pending[3]!.resolve();
  await release;
  assert.deepEqual(player.onEnded(0), { clip: 'release', generation: 4 });
  assert.equal(player.onEnded(1), undefined);
  const failed = player.show('work', 5);
  pending[4]!.reject();
  await failed;
  assert.deepEqual(errors, ['work']);
  assert.deepEqual(swaps, ['0:idle', '1:drag', '0:release']);
});

test('only fixed same-origin resources are served and WebM single ranges are bounded', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-video-routes-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'idle.webm'), '0123456789');
  await writeFile(join(folder, 'not-public.txt'), 'secret');
  const get = (url: string, range?: string, method = 'GET') => previewResponse(folder,
    new Request(url, { method, headers: range ? { range } : {} }));
  const media = new URL('idle.webm', previewURL).href;
  const part = await get(media, 'bytes=2-4');
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(part.headers.get('content-type'), 'video/webm');
  assert.equal(await part.text(), '234');
  assert.equal(await (await get(media, 'bytes=-2')).text(), '89');
  assert.equal((await get(media, 'bytes=10-')).status, 416);
  assert.equal((await get(media, 'bytes=0-1,3-4')).status, 416);
  assert.equal((await get(media, undefined, 'POST')).status, 405);
  for (const url of [new URL('not-public.txt', previewURL).href, `${media}?path=elsewhere`, media.replace('://preview', '://other')]) {
    assert.equal((await get(url)).status, 404);
  }
});

test('a naturally ended work clip is replayable without exposing a blank frame or accepting duplicate ends', async () => {
  const swaps: number[] = [];
  const player = createClipSwitcher({ canReuse: () => true, prepare: async () => {}, reveal: slot => { swaps.push(slot); }, fail: () => assert.fail() });
  await player.show('work', 1);
  assert.deepEqual(player.onEnded(0), { clip: 'work', generation: 1 });
  assert.equal(player.onEnded(0), undefined);
  await player.show('work', 2);
  assert.deepEqual(swaps, [0, 1]);
});

test('a release clip can reuse the active decoder slot and retire the old clip', async () => {
  const events: string[] = [];
  let resolveRelease!: () => void;
  const player = createClipSwitcher({ canReuse: () => true,
    retarget: (_slot, from, to) => from === 'move02' && to === 'release-move02',
    prepare(slot, clip) {
      events.push(`prepare:${slot}:${clip}`);
      return clip === 'release-move02' ? new Promise<void>(resolve => { resolveRelease = resolve; }) : Promise.resolve();
    }, reveal: (slot, clip) => { events.push(`shown:${slot}:${clip}`); }, fail: () => assert.fail() });
  await player.show('move02', 1);
  const release = player.show('release-move02', 2);
  assert.deepEqual(events, ['prepare:0:move02', 'shown:0:move02', 'prepare:0:release-move02']);
  assert.equal(player.onEnded(0), undefined, 'a retargeting slot cannot emit the outgoing clip end');
  resolveRelease();
  await release;
  assert.equal(events.at(-1), 'shown:0:release-move02');
});

test('a clip ending during its replacement must prepare a fresh frame before it can be shown again', async () => {
  const events: string[] = [];
  let finishReplay!: () => void;
  const player = createClipSwitcher({ canReuse: () => true, prepare(slot, clip, signal) {
    events.push(`prepare:${slot}:${clip}`);
    if (clip === 'move02') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if (slot === 1) return new Promise(resolve => { finishReplay = resolve; });
    return Promise.resolve();
  }, reveal: (slot, clip, generation) => { events.push(`shown:${slot}:${clip}:${generation}`); }, fail: () => assert.fail() });
  await player.show('once-idle', 1);
  const replacement = player.show('move02', 2);
  assert.equal(player.onEnded(0), undefined, 'retire the old clip without reporting a stale end');
  const replay = player.show('once-idle', 3);
  await replacement;
  assert.deepEqual(events, ['prepare:0:once-idle', 'shown:0:once-idle:1', 'prepare:1:move02', 'prepare:1:once-idle']);
  finishReplay();
  await replay;
  assert.equal(events.at(-1), 'shown:1:once-idle:3');
});

test('an already terminal media element cannot be reused before its DOM event dispatches', async () => {
  const swaps: number[] = [];
  let usable = true;
  const player = createClipSwitcher({ canReuse: () => usable, prepare: async () => {},
    reveal: slot => { swaps.push(slot); }, fail: () => assert.fail() });
  await player.show('idle', 1);
  await player.show('idle', 2);
  usable = false;
  await player.show('idle', 3);
  assert.deepEqual(swaps, [0, 0, 1]);
});

test('runtime failure retires only the current owner and is acknowledged just once', async () => {
  const swaps: number[] = [];
  const player = createClipSwitcher({ canReuse: () => true, prepare: async () => {},
    reveal: slot => { swaps.push(slot); }, fail: () => assert.fail() });
  await player.show('release-move02', 1);
  await player.show('release-move02', 2);
  assert.equal(player.onFailed(0, 1), undefined);
  await player.show('release-move02', 3);
  assert.deepEqual(player.onFailed(0, 3), { clip: 'release-move02', generation: 3 });
  assert.equal(player.onFailed(0, 3), undefined);
  await player.show('release-move02', 4);
  assert.deepEqual(swaps, [0, 0, 0, 1]);
  assert.equal(player.onFailed(0, 4), undefined);
});

test('locomotion and release use fixed in-clip ranges without new public files', async () => {
  const browser = await import('../src/video-preview/playback.ts');
  assert.deepEqual(browser.clipSource('move01left'), { file: 'move01left', range: [1000, 3250], facing: 'left' });
  assert.deepEqual(browser.clipSource('release-move03left'), {
    file: 'move03left', range: [113 * 1000 / 30, 158 * 1000 / 30], facing: 'left',
  });
  assert.equal(browser.isClip('release-move01right'), false);
  const folder = await mkdtemp(join(tmpdir(), 'video-motion-routes-'));
  try {
    await writeFile(join(folder, 'move03left.webm'), 'sample');
    await writeFile(join(folder, 'release-move03left.webm'), 'not a resource');
    assert.equal((await previewResponse(folder, new Request(new URL('move03left.webm', previewURL)))).status, 200);
    assert.equal((await previewResponse(folder, new Request(new URL('release-move03left.webm', previewURL)))).status, 404);
  } finally { await rm(folder, { force: true, recursive: true }); }
});

test('display acknowledgements carry the latest request even when a canceled clip is requested again', async () => {
  const pending: (() => void)[] = [];
  const frames: unknown[] = [];
  const player = createClipSwitcher({ canReuse: () => true, prepare: () => new Promise<void>(resolve => pending.push(resolve)),
    reveal: (...args) => frames.push(args), fail: () => assert.fail() });
  const first = player.show('work', 1);
  const second = player.show('idle', 2);
  const third = player.show('work', 3);
  pending[0]!(); pending[1]!(); await first; await second;
  assert.deepEqual(frames, []);
  pending[2]!(); await third;
  assert.deepEqual(frames, [[0, 'work', 3]]);
  assert.deepEqual(player.onEnded(0), { clip: 'work', generation: 3 });
});

class VideoFixture extends EventTarget {
  src = '';
  currentTime = 0;
  duration = 11;
  readyState = 0;
  seeking = false;
  muted = false;
  loop = false;
  playing = false;
  loads = 0;
  private callback?: (now: number, meta: { mediaTime: number }) => void;
  load() { this.loads++; }
  pause() { this.playing = false; }
  play() { this.playing = true; return Promise.resolve(); }
  removeAttribute() { this.src = ''; }
  requestVideoFrameCallback(cb: VideoFixture['callback']) { this.callback = cb; return 1; }
  cancelVideoFrameCallback() { this.callback = undefined; }
  frame(mediaTime: number) {
    const cb = this.callback;
    this.callback = undefined;
    cb?.(0, { mediaTime });
  }
  get port() { return this as unknown as HTMLVideoElement; }
}

test('a segment seeks before play, rejects intro frames and loops through the same source', async () => {
  const { prepareFirstFrame, keepSegment } = await import('../src/video-preview/video-segment.ts');
  const video = new VideoFixture();
  let ready = false;
  const pending = prepareFirstFrame(video.port, 'move02', new AbortController().signal).then(() => { ready = true; });
  assert.equal(video.playing, false);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.currentTime, 4.75);
  assert.equal(video.loop, false);
  assert.equal(video.playing, true);
  video.frame(.04);
  await Promise.resolve();
  assert.equal(ready, false);
  video.frame(4.75);
  await pending;
  assert.equal(ready, true);
  const close = keepSegment(video.port, 'move02', () => assert.fail());
  video.currentTime = 7.417;
  video.frame(7.417);
  assert.equal(video.currentTime, 7.417);
  video.frame(7.5);
  assert.equal(video.currentTime, 4.75);
  assert.equal(video.src, './move02.webm');
  close();
  video.currentTime = 7.5;
  video.frame(7.5);
  assert.equal(video.currentTime, 7.5);
});

test('the companion rebound plays only its pinned jump range once and reports its generation end', async () => {
  const { prepareFirstFrame, keepSegment } = await import('../src/video-preview/video-segment.ts');
  const video = new VideoFixture();
  let ended = false;
  const ready = prepareFirstFrame(video.port, 'companion-rebound', new AbortController().signal);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.currentTime, 3.75);
  video.frame(3.75);
  await ready;
  const stop = keepSegment(video.port, 'companion-rebound', () => assert.fail('range decode failed'), {
    frame() {}, seamStart() {}, seamEnd() {}, ended() { ended = true; },
  });
  video.frame(5.26);
  assert.equal(ended, true);
  assert.equal(video.playing, false);
  stop();
});

test('a prepared release can continue on the active decoder without seeking or reloading the WebM', async () => {
  const { prepareFirstFrame } = await import('../src/video-preview/video-segment.ts');
  const video = new VideoFixture();
  const initial = prepareFirstFrame(video.port, 'move02', new AbortController().signal);
  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  video.readyState = 2;
  video.frame(4.75);
  await initial;
  video.currentTime = 5.75;
  const loads = video.loads;
  const release = prepareFirstFrame(video.port, 'release-move02', new AbortController().signal, undefined, true);
  assert.equal(video.loads, loads);
  assert.equal(video.currentTime, 5.75, 'already decoded frames in the release interval need no seek');
  video.frame(5.79);
  await release;
});

test('aborted segment preparation cannot react to late metadata or leave a decoder playing', async () => {
  const { prepareFirstFrame } = await import('../src/video-preview/video-segment.ts');
  const video = new VideoFixture();
  const abort = new AbortController();
  const pending = prepareFirstFrame(video.port, 'release-move02', abort.signal);
  abort.abort();
  await assert.rejects(pending, /首帧/);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.playing, false);
  assert.equal(video.src, '');
});

test('drag transitions preserve the Qt entry/return timing and reduced motion bypass', async () => {
  const { dragBlendMs, smoothMix } = await import('../src/video-preview/pose-blend.ts');
  assert.equal(dragBlendMs('idle', 'move01left', false), 160);
  assert.equal(dragBlendMs('move03right', 'release-move02', false), 160);
  assert.equal(dragBlendMs('release-move02left', 'idle', false), 280);
  assert.equal(dragBlendMs('release-move02left', 'idle', true), 0);
  assert.equal(smoothMix(.25), .15625);
});

test('the original clip catalog is complete; playback and internal movement-loop identities stay distinct', async () => {
  const { mediaFiles, clipSource, loops, isClip } = await import('../src/video-preview/playback.ts');
  assert.equal(new Set(mediaFiles).size, 35);
  for (const id of ['idle2', 'idle06', '26', 'quota', 'work05', 'full-move03left'] as const) assert.ok(isClip(id));
  assert.equal(loops('idle2'), true);
  assert.equal(loops('idle06'), false);
  assert.equal(loops('quota'), false);
  assert.deepEqual(clipSource('full-move03left'), { file: 'move03left', facing: 'left' });
  assert.equal(loops('full-move03left'), false);
  assert.equal(loops('move03left'), true);
  assert.equal(loops('companion-hover'), true);
  assert.equal(loops('companion-wave'), false);
  assert.equal(loops('companion-rebound'), false);
  assert.deepEqual(clipSource('companion-rebound'), { file: 'companion-jump', range: [3750, 5300] });
});

test('pose rectangle matches the pinned Qt bottom anchor, overscan and absolute-source flight correction', async () => {
  const { poseRect, paddedSize, nominalSize } = await import('../src/video-preview/pose-geometry.ts');
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
  for (let size = 96; size <= 520; size++) assert.equal(nominalSize(paddedSize(size)), size);
  assert.deepEqual(poseRect('idle', 280, 0, false), { x: 70, y: 70, width: 280, mirrored: false });
  const left = poseRect('move03left', 280, 4000, false);
  const leftRelease = poseRect('release-move03left', 280, 4000, true);
  const right = poseRect('move03right', 280, 4000, false);
  close(left.width, 364);
  close(left.y, 70 + 280 - 364 + 280 * .013951388888888916);
  close(left.width, leftRelease.width);
  close(left.x + leftRelease.x + left.width, paddedSize(280));
  close(right.width, 280 * 1.0183333333333333);
  for (const time of [0, 2500, 6700, 9000]) close(poseRect('move03left', 280, time, false).width, right.width);
});

test('a movement seam freezes its last legal pose and waits for the seeked head, ignoring late and intro frames', async () => {
  const { keepSegment } = await import('../src/video-preview/video-segment.ts');
  const video = new VideoFixture();
  const poses: string[] = [];
  const stop = keepSegment(video.port, 'move02', () => assert.fail('segment failed'), {
    frame: ms => poses.push(`frame:${ms}`),
    seamStart: hasTail => poses.push(`freeze:${hasTail}`),
    seamEnd: () => poses.push('resume'),
  });
  try {
    video.frame(7.417);
    assert.deepEqual(poses, ['frame:7417']);
    video.frame(7.458); // last 24fps frame of the half-open movement interval
    assert.equal(video.currentTime, 4.75);
    assert.deepEqual(poses, ['frame:7417', 'frame:7458', 'freeze:true']);
    video.seeking = true;
    video.frame(4.75);
    video.seeking = false;
    video.frame(7.5);
    video.frame(4.708);
    assert.equal(poses.length, 3);
    video.frame(4.75);
    assert.deepEqual(poses.slice(3), ['frame:4750', 'resume']);
  } finally { stop(); }
  video.frame(7.458);
  assert.equal(poses.length, 5);
});

test('only a decoded release pose gets a bounce turn blend; changing face never reloads a clip', async () => {
  const { bounceBlendMs } = await import('../src/video-preview/pose-blend.ts');
  assert.equal(bounceBlendMs('release-move02', false, true, false, false), 60);
  assert.equal(bounceBlendMs('release-move03left', true, true, false, false), 0);
  assert.equal(bounceBlendMs('release-move03left', true, false, true, false), 0);
  assert.equal(bounceBlendMs('release-move02left', true, false, false, true), 0);
  assert.equal(bounceBlendMs('move03right', true, false, false, false), 0);
});

test('the fixed caption font route refuses missing, loose or unapproved bytes', async t => {
  const { captionFont, readCaptionFont } = await import('../src/video-preview/media.ts');
  const folder = await mkdtemp(join(tmpdir(), 'pet-video-font-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'index.html'), '<p>fixture</p>');
  const url = new URL('caption-font.ttf', previewURL);
  assert.equal(captionFont, 'caption-font.ttf');
  assert.equal(await readCaptionFont(folder), undefined);
  await writeFile(join(folder, captionFont), 'not the approved font', { mode: 0o600 });
  assert.equal(await readCaptionFont(folder), undefined);
  assert.equal((await previewResponse(folder, new Request(url))).status, 404);
  assert.match((await previewResponse(folder, new Request(previewURL))).headers.get('content-security-policy')!, /font-src 'self'/);
});

test('the companion origin serves only its idle, fixed UI and prevalidated local font', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-companion-route-'));
  t.after(() => rm(folder, { force: true, recursive: true }));
  for (const [name, contents] of [['index.html', 'page'], ['idle.webm', 'idle'], ['companion-hover.webm', 'hover'], ['work.webm', 'not a companion clip']]) {
    await writeFile(join(folder, name!), contents!);
  }
  await writeFile(join(folder, 'caption-font.ttf'), 'unvalidated disk file');
  const get = (path: string, host = 'companion', font?: ArrayBuffer, method = 'GET') =>
    previewResponse(folder, new Request(`pet-video://${host}/${path}`, { method }), folder, font, 'companion');
  assert.equal(await (await get('idle.webm')).text(), 'idle');
  assert.equal(await (await get('companion-hover.webm')).text(), 'hover');
  assert.equal((await previewResponse(folder, new Request('pet-video://preview/companion-hover.webm'))).status, 404);
  assert.equal(await (await get('index.html')).text(), 'page');
  const validatedFont = new TextEncoder().encode('validated bytes fixture').buffer;
  assert.equal((await get('caption-font.ttf')).status, 404); // Never read arbitrary bytes from disk.
  const served = await get('caption-font.ttf', 'companion', validatedFont);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'font/ttf');
  assert.match(served.headers.get('content-security-policy')!, /font-src 'self'/);
  assert.deepEqual(await served.arrayBuffer(), validatedFont);
  const head = await get('caption-font.ttf', 'companion', validatedFont, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(validatedFont.byteLength));
  assert.equal(await head.text(), '');
  for (const path of ['work.webm', 'companion-jump.webm', 'cover.png', 'idle.webm?source=other', 'captions.json', 'caption-font.ttf?source=other']) {
    assert.equal((await get(path, 'companion', validatedFont)).status, 404);
  }
  assert.equal((await get('idle.webm', 'preview')).status, 404);
  assert.equal((await get('caption-font.ttf', 'preview', validatedFont)).status, 404);
  assert.equal((await previewResponse(folder, new Request('pet-video://companion/idle.webm'))).status, 404);
});
