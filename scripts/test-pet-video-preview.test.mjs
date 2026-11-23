import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { buildPreview, companionCheckMessages } from './run-pet-video-preview.mjs';

test('鲸鱼妹 stages only approved private clips and preserves existing local artwork', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-local-assets-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'scripts', 'prepare-local-companion.mjs');
  await mkdir(dirname(script));
  await copyFile(new URL('./prepare-local-companion.mjs', import.meta.url), script);
  const idle = Buffer.from('synthetic-pinned-video');
  const hover = Buffer.from('synthetic-hover-video');
  const jump = Buffer.from('synthetic-jump-video');
  const pin = (bytes, source) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source });
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config', 'local-companion-media.json'), JSON.stringify({
    ...pin(idle, 'idle.webm'), actions: { 'companion-hover': pin(hover, 'hover.webm'), 'companion-jump': pin(jump, 'jump.webm') },
  }));
  const { prepareCompanion, stageLocalCompanion } = await import(pathToFileURL(script));
  const character = join(root, '.local', 'pets', 'dafeiyu');
  const videos = join(character, 'videos');
  const cover = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(cover);
  cover.writeUInt32BE(222, 16);
  cover.writeUInt32BE(278, 20);
  cover[24] = 8; cover[25] = 6;
  const legacy = join(dirname(character), 'companion');
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await writeFile(join(legacy, 'cover.png'), cover, { mode: 0o600 });
  await writeFile(join(legacy, 'idle.webm'), idle, { mode: 0o600 });
  const session = join(root, 'session');
  await mkdir(session);
  await mkdir(videos, { recursive: true, mode: 0o700 });
  await writeFile(join(character, 'cover.png'), cover, { mode: 0o600 });
  await writeFile(join(videos, 'idle.webm'), idle, { mode: 0o600 });

  await rename(videos, videos + '-other');
  await symlink(videos + '-other', videos);
  assert.equal((await stageLocalCompanion(session)).ready, false, 'must not follow symlinks or use the old directory');
  assert.deepEqual(await readdir(session), []);
  await rm(videos);
  await rename(videos + '-other', videos);
  const stagedWithoutActions = await stageLocalCompanion(session);
  assert.equal(stagedWithoutActions.ready, true);
  assert.deepEqual(stagedWithoutActions.availableActions, []);
  assert.deepEqual(stagedWithoutActions.missingActions, ['companion-hover', 'companion-jump']);
  assert.deepEqual(companionCheckMessages(stagedWithoutActions), [
    '鲸鱼妹：固定待机 WebM 与封面已通过校验；动作 0/11 段可用。',
    '鲸鱼妹缺少或校验失败的可选动作：拖拽悬空、开心跃动',
  ]);
  assert.deepEqual(companionCheckMessages({ ready: false, availableActions: [], missingActions: [] }), [
    '鲸鱼妹：待机 WebM 或封面缺失、权限不符合要求或校验失败；动作状态未检查。',
  ]);
  assert.deepEqual(await readFile(join(session, 'companion', 'cover.png')), cover);
  assert.deepEqual(await readFile(join(session, 'companion', 'idle.webm')), idle);
  assert.deepEqual((await readdir(join(session, 'companion'))).sort(), ['cover.png', 'idle.webm']);

  const cover2x = Buffer.from(cover);
  cover2x.writeUInt32BE(444, 16);
  cover2x.writeUInt32BE(556, 20);
  const session2x = join(root, 'session-2x');
  await mkdir(session2x);
  await writeFile(join(character, 'cover.png'), cover2x, { mode: 0o600 });
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'idle.webm'), idle);
  await writeFile(join(source, 'hover.webm'), hover);
  await writeFile(join(source, 'jump.webm'), jump);
  await prepareCompanion(source);
  await prepareCompanion(source); // Idempotent; does not regenerate or overwrite the cover.
  await writeFile(join(videos, 'companion-jump.webm'), Buffer.alloc(jump.length));
  await writeFile(join(videos, 'unknown.webm'), hover, { mode: 0o600 });
  await assert.rejects(prepareCompanion(source));
  assert.deepEqual(await readFile(join(videos, 'companion-jump.webm')), Buffer.alloc(jump.length));
  const stagedWithMissingJump = await stageLocalCompanion(session2x);
  assert.equal(stagedWithMissingJump.ready, true);
  assert.deepEqual(stagedWithMissingJump.availableActions, ['companion-hover']);
  assert.deepEqual(stagedWithMissingJump.missingActions, ['companion-jump']);
  assert.deepEqual(companionCheckMessages(stagedWithMissingJump), [
    '鲸鱼妹：固定待机 WebM 与封面已通过校验；动作 1/11 段可用。',
    '鲸鱼妹缺少或校验失败的可选动作：开心跃动',
  ]);
  assert.deepEqual(await readFile(join(session2x, 'companion', 'cover.png')), cover2x);
  assert.deepEqual(await readFile(join(session2x, 'companion', 'idle.webm')), idle);
  assert.deepEqual(await readFile(join(session2x, 'companion', 'companion-hover.webm')), hover);
  assert.deepEqual((await readdir(join(session2x, 'companion'))).sort(), ['companion-hover.webm', 'cover.png', 'idle.webm']);

  const rejected = join(root, 'session-invalid');
  await mkdir(rejected);
  for (const [width, height, colorType] of [[445, 556, 6], [222, 556, 6], [444, 556, 2]]) {
    const invalid = Buffer.from(cover2x);
    invalid.writeUInt32BE(width, 16);
    invalid.writeUInt32BE(height, 20);
    invalid[25] = colorType;
    await writeFile(join(character, 'cover.png'), invalid, { mode: 0o600 });
    assert.equal((await stageLocalCompanion(rejected)).ready, false);
    assert.deepEqual(await readdir(rejected), []);
  }
});

async function waitForWindow(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('owned preview did not finish loading');
}

test('video preview bundles independently without media, workspace or Qt runtime', async t => {
  const out = await mkdtemp(join(tmpdir(), 'pet-video-build-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildPreview(out);
  assert.deepEqual((await readdir(out)).sort(), ['index.html', 'main.cjs', 'package.json', 'preload.cjs', 'quota_source.py', 'renderer.js', 'style.css']);
  const read = name => readFile(join(out, name), 'utf8');
  assert.equal(JSON.parse(await read('package.json')).main, 'main.cjs');
  const main = await read('main.cjs');
  const preload = await read('preload.cjs');
  const renderer = await read('renderer.js');
  assert.match(main, /transparent: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /mainFrame/);
  assert.match(preload, /exposeInMainWorld\("petVideoPreview"/);
  assert.doesNotMatch(preload, /node:fs|node:child_process|savePreferences|serviceWorker/);
  assert.match(renderer, /requestVideoFrameCallback/);
  assert.doesNotMatch(renderer, /require\(["']electron["']\)/);
  assert.doesNotMatch(main, /PySide6|PET_PLAYER_SOURCE|@pet\/app-service|launchCodex/);
  const html = await read('index.html');
  assert.equal(html.match(/<video\b/g)?.length, 2);
  assert.match(html, /id="pet-name"[^>]*hidden[^>]*>龙妹<\//);
  const css = await read('style.css');
  const nameAndStatus = css.match(/#pet-name,\s*output\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(nameAndStatus, /font:\s*13px SSRuanTangTi,\s*var\(--preview-rounded-font\)/);
  const nameBubble = css.match(/#pet-name\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(nameBubble, /pointer-events:\s*none/);
  assert.match(css, /@font-face\s*\{[^}]*SSRuanTangTi[^}]*caption-font\.ttf/);
  assert.match(css, /#pet-caption\s*\{[^}]*SSRuanTangTi[^}]*text-align:\s*center/);
  const quotaBubble = css.match(/#pet-quota\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(quotaBubble, /font:\s*13px\/1\.4\s+SSRuanTangTi,\s*var\(--preview-rounded-font\)/);
  assert.match(quotaBubble, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /#pet-quota button\s*\{[^}]*font:\s*18px\/1 system-ui/);
});

test('fixed archive extraction runs only against synthetic local assets in CI', () => {
  const python = process.env.PET_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['-I', '-B', 'scripts/test-video-preview-assets.py'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});


test('quota sources use synthetic TOML, SQLite, HTTP and CLI', { skip: process.platform === 'win32' }, () => {
  const python = process.env.PET_PYTHON || 'python3';
  const result = spawnSync(python, ['-I', '-B', 'scripts/test-video-preview-quota.py'], {
    encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('bundled renderer gates name, menu and quota on current alpha and drag state', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-video-renderer-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await buildPreview(folder);
  const video = () => {
    const handlers = new Map();
    return { visible: false, paused: true, ended: false, error: null, callback: undefined, style: {}, duration: 15,
      readyState: 2, loads: 0, src: '', currentTime: 0,
      addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
      removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
      dispatch(name) { for (const fn of [...handlers.get(name) ?? []]) fn(); },
      classList: {}, load() { this.loads++; this.ended = false; this.error = null; }, removeAttribute() { this.src = ''; },
      async play() { this.paused = false; }, pause() { this.paused = true; },
      requestVideoFrameCallback(fn) { this.callback = fn; return 1; },
      cancelVideoFrameCallback() { this.callback = undefined; },
    };
  };
  const idle = video(), work = video();
  for (const layer of [idle, work]) layer.classList.toggle = (name, value) => { if (name === 'visible') layer.visible = value; };
  let action, reset, menuState, quotaState, captured, menuRequests = 0;
  const quotaRequests = [], quotaElements = new Map(), quotaEvents = new Map();
  const quotaCard = { hidden: true, getBoundingClientRect: () => ({ left: 30, top: 2, right: 70, bottom: 20 }) };
  const frames = [], hits = [], gestures = [];
  let readbacks = 0;
  const output = {};
  const label = { hidden: true, offsetWidth: 26, offsetHeight: 18, style: {} };
  const events = new Map(), documentEvents = new Map();
  const pixels = new Uint8ClampedArray(96 * 96 * 4);
  pixels[(10 * 96 + 10) * 4 + 3] = 255;
  pixels[(14 * 96 + 15) * 4 + 3] = 255;
  pixels[(95 * 96 + 95) * 4 + 3] = 255;
  const surface = { clearRect() {}, drawImage() {} };
  const overlay = { hidden: true, getContext: () => surface };
  let animation, nextFrame = 0, frameTime = 0;
  const settleBlend = () => {
    for (let i = 0; i < 10 && animation; i++) { const tick = animation; animation = undefined; tick(frameTime += 40); }
    assert.equal(overlay.hidden, true);
  };
  const window = { innerWidth: 96, innerHeight: 96, devicePixelRatio: 1,
    requestAnimationFrame(fn) { animation = fn; return ++nextFrame; }, cancelAnimationFrame() { animation = undefined; },
    petVideoPreview: { onCaption() {}, onAction(fn) { action = fn; }, onDragReset(fn) { reset = fn; },
      onMenuState(fn) { menuState = fn; }, onFace() {}, reducedMotion() {}, openMenu() { menuRequests++; },
      onQuota(fn) { quotaState = fn; }, requestQuota() { quotaRequests.push('open'); },
      refreshQuota() { quotaRequests.push('refresh'); }, closeQuota() { quotaRequests.push('close'); },
      frame(...args) { frames.push(args); }, hit(value) { hits.push(value); }, gesture(value) { gestures.push(value); } },
    addEventListener(name, fn) { events.set(name, fn); }, matchMedia: () => ({ matches: false, addEventListener() {} }), setTimeout, setInterval: () => 1 };
  const document = { querySelectorAll: () => [idle, work], querySelector(selector) {
      if (selector === '#pet-name') return label;
      if (selector === '#pet-quota') return quotaCard;
      if (selector === '#pet-pose') return overlay;
      if (!selector.startsWith('#quota-')) return output;
      if (!quotaElements.has(selector)) quotaElements.set(selector, { append() {}, replaceChildren() {}, addEventListener(_name, fn) { quotaEvents.set(selector, fn); } });
      return quotaElements.get(selector);
    },
    createElement: () => ({ append() {}, getContext: () => ({ clearRect() {}, drawImage() {}, getImageData: () => { readbacks++; return { data: pixels }; } }) }),
    documentElement: { addEventListener(name, fn) { documentEvents.set(name, fn); } }, body: { toggleAttribute() {},
      setPointerCapture(id) { captured = id; }, hasPointerCapture(id) { return captured === id; },
      releasePointerCapture() { captured = undefined; } } };
  const renderer = await readFile(join(folder, 'renderer.js'), 'utf8');
  const boot = host => runInNewContext(renderer, { window, document, location: new URL(`pet-video://${host}/index.html`), setTimeout, clearTimeout, clearInterval, AbortController });
  boot('preview');
  const rightClick = (x, y) => events.get('contextmenu')({ button: 2, clientX: x, clientY: y, preventDefault() {} });
  rightClick(10, 10);
  assert.equal(menuRequests, 0);
  action('idle', 1);
  assert.equal(idle.visible, false);
  idle.callback(0, { mediaTime: 0 });
  await Promise.resolve();
  assert.equal(idle.loop, true);
  assert.equal(idle.visible, true);
  action('work', 2);
  assert.equal(idle.visible, true);
  assert.equal(idle.paused, false);
  assert.equal(work.visible, false);
  work.callback(0, { mediaTime: 0 });
  await Promise.resolve();
  assert.equal(work.loop, false);
  assert.equal(work.visible, true);
  assert.equal(idle.paused, true);
  work.ended = true;
  work.dispatch('ended');
  assert.deepEqual(frames, [['shown', 'idle', 1], ['shown', 'work', 2], ['ended', 'work', 2]]);
  events.get('mousemove')({ clientX: 10, clientY: 10 });
  assert.equal(label.hidden, false);
  const firstPosition = label.style.transform;
  events.get('mousemove')({ clientX: 15, clientY: 14 });
  assert.notEqual(label.style.transform, firstPosition);
  events.get('mousemove')({ clientX: 95, clientY: 95 });
  assert.equal(label.style.transform, 'translate(61px, 69px)'); // Flip to the inside edge.
  events.get('mousemove')({ clientX: 20, clientY: 20 });
  assert.equal(label.hidden, true);
  assert.deepEqual(hits, [true, false]); // No mask timer tick between the two movements.
  rightClick(20, 20);
  assert.equal(menuRequests, 0);
  rightClick(10, 10);
  assert.equal(menuRequests, 1);
  menuState(true);
  assert.equal(label.hidden, true);
  menuState(false, { x: 10, y: 10 });
  assert.equal(label.hidden, false);
  documentEvents.get('mouseleave')();
  assert.equal(label.hidden, true);
  events.get('mousemove')({ clientX: 10, clientY: 10 });
  events.get('pointerdown')({ button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  assert.equal(captured, 1);
  assert.equal(label.hidden, true);
  rightClick(10, 10);
  assert.equal(menuRequests, 1);
  reset(); // Native blur/watchdog without a renderer pointerup.
  assert.equal(captured, undefined);
  events.get('pointerdown')({ button: 0, pointerId: 2, clientX: 20, clientY: 20 });
  assert.equal(captured, undefined);
  events.get('mousemove')({ clientX: 10, clientY: 10 });
  events.get('pointerdown')({ button: 0, pointerId: 3, clientX: 10, clientY: 10 });
  assert.equal(captured, 3);
  assert.deepEqual(gestures, ['begin', 'begin']);
  reset();
  events.get('dblclick')({ button: 0, clientX: 20, clientY: 20 });
  assert.deepEqual(quotaRequests, []); // Transparent video pixels cannot open a quota card.
  for (const pointerId of [4, 5]) {
    events.get('pointerdown')({ button: 0, pointerId, clientX: 10, clientY: 10, screenX: 200, screenY: 200 });
    events.get('pointerup')({ button: 0, pointerId, clientX: 10, clientY: 10, screenX: 200, screenY: 200 });
  }
  events.get('dblclick')({ button: 0, clientX: 10, clientY: 10 });
  assert.deepEqual(quotaRequests, ['open']);
  quotaState({ kind: 'loading' });
  assert.equal(quotaCard.hidden, false);
  assert.equal(quotaElements.get('#quota-refresh').disabled, true);
  quotaState({ kind: 'balance', amount: 12.5, currency: 'EUR', queriedAt: 1700000000000 });
  assert.equal(quotaElements.get('#quota-title').textContent, '中转余额');
  assert.equal(quotaElements.get('#quota-source').textContent, 'TiMi CC · EUR');
  assert.equal(quotaElements.get('#quota-refresh').disabled, false);
  const gesturesBeforeCard = gestures.length;
  events.get('pointerdown')({ button: 0, pointerId: 6, clientX: 40, clientY: 10 });
  assert.equal(gestures.length, gesturesBeforeCard); // The card is clickable over transparent pixels without starting a drag.
  quotaEvents.get('#quota-refresh')();
  quotaEvents.get('#quota-close')();
  assert.deepEqual(quotaRequests, ['open', 'refresh', 'close']);
  quotaState({ kind: 'closed' });
  assert.equal(quotaCard.hidden, true);

  await t.test('light drag handoff keeps both sides moving at the right time', async () => {
    action('idle', 3);
    idle.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    action('move01right', 4);
    assert.equal(idle.paused, false, 'outgoing idle keeps moving during a range seek');
    assert.equal(overlay.hidden, true);
    work.dispatch('loadedmetadata');
    work.callback(0, { mediaTime: .75 });
    await Promise.resolve();
    assert.equal(overlay.hidden, false);
    assert.equal(work.paused, false, 'incoming walk plays during the blend');
    settleBlend();

    action('idle', 5);
    assert.equal(work.paused, false, 'outgoing walk keeps moving until idle is ready');
    assert.ok(work.callback, 'outgoing segment clock is still active');
    idle.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    assert.equal(overlay.hidden, false);
    assert.equal(idle.paused, false, 'return to idle plays during the blend');
    settleBlend();
  });

  await t.test('flick resumes on its decoded head; duplicate or failed requests do not freeze it', async () => {
    action('release-move02', 6);
    assert.equal(idle.paused, false, 'wait for fling head without freezing idle');
    work.dispatch('loadedmetadata');
    work.callback(0, { mediaTime: 125 / 24 });
    await Promise.resolve();
    assert.equal(overlay.hidden, false);
    assert.equal(work.paused, false);
    assert.deepEqual(frames.at(-1), ['shown', 'release-move02', 6]);
    const segment = work.callback;
    action('release-move02', 7);
    assert.equal(work.callback, segment, 'acknowledging the same clip keeps its segment clock');
    assert.equal(overlay.hidden, false, 'same clip does not restart or cancel the blend');
    assert.deepEqual(frames.at(-1), ['shown', 'release-move02', 7]);
    settleBlend();

    action('release-move03right', 8);
    idle.dispatch('error');
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['failed', 'release-move03right', 8]);
    assert.equal(work.paused, false);
    assert.equal(overlay.hidden, true);
  });

  await t.test('light drop does not acknowledge an idle clip that failed during a pending move seek', async () => {
    action('idle', 9);
    idle.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    settleBlend();
    action('move01right', 10);
    idle.error = { code: 3 }; // The old decoder stopped while the other layer was preparing.
    idle.paused = true;
    idle.dispatch('error');
    action('idle', 11);
    assert.notDeepEqual(frames.at(-1), ['shown', 'idle', 11], 'the failed visible layer is never a new first frame');
    assert.deepEqual(frames.at(-1), ['shown', 'idle', 9], 'a stale failure is not forwarded');
    assert.equal(idle.visible, true, 'retain the old frame until the replacement can be shown');
    const beforeReveal = readbacks;
    work.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['shown', 'idle', 11]);
    assert.equal(work.paused, false);
    assert.equal(readbacks - beforeReveal, 1, 'a hovered handoff reads its alpha mask once');
  });

  await t.test('a release on the current movement source reuses its decoder and preserves the frozen pose until ready', async () => {
    action('move02', 12);
    idle.dispatch('loadedmetadata');
    idle.callback(0, { mediaTime: 4750 / 1000 });
    await Promise.resolve();
    settleBlend();
    const loads = idle.loads;
    idle.currentTime = 5.75;
    idle.callback(0, { mediaTime: 5.75 });
    action('release-move02', 13);
    assert.equal(overlay.hidden, false, 'keep the last good pose visible until the next release frame');
    assert.equal(idle.loads, loads, 'same-file release does not reload the WebM decoder');
    assert.equal(idle.currentTime, 5.75, 'reuse a frame already decoded inside the release interval');
    idle.callback(0, { mediaTime: 5.79 });
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['shown', 'release-move02', 13]);
    assert.equal(overlay.hidden, false, 'blend starts only after the release frame is decoded');
    assert.equal(idle.paused, false, 'the incoming release continues playing during the blend');
    settleBlend();
  });

  await t.test('an out-of-range release prepares on the other decoder without freezing the drag', async () => {
    action('move02', 14);
    work.dispatch('loadedmetadata');
    work.callback(0, { mediaTime: 4.75 });
    await Promise.resolve();
    settleBlend();
    action('release-move02', 15);
    assert.equal(work.paused, false);
    assert.equal(overlay.hidden, true);
    assert.equal(idle.src, './move02.webm');
    idle.dispatch('loadedmetadata');
    idle.callback(0, { mediaTime: 5.25 });
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['shown', 'release-move02', 15]);
    settleBlend();
  });

  await t.test('same-source failure and cancellation retain the snapshot only until the replacement is ready', async () => {
    action('move02', 16);
    work.dispatch('loadedmetadata');
    work.callback(0, { mediaTime: 5.75 });
    await Promise.resolve();
    settleBlend();
    work.currentTime = 5.75;
    action('release-move02', 17);
    assert.equal(overlay.hidden, false);
    work.error = { code: 3 };
    work.dispatch('error');
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['failed', 'release-move02', 17]);
    assert.equal(work.src, '');
    assert.equal(overlay.hidden, false, 'no flash before a new first frame');
    action('idle', 18);
    idle.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    settleBlend();
    assert.deepEqual(frames.at(-1), ['shown', 'idle', 18]);

    action('move02', 19);
    work.dispatch('loadedmetadata');
    work.callback(0, { mediaTime: 5.75 });
    await Promise.resolve();
    settleBlend();
    work.currentTime = 5.75;
    action('release-move02', 20);
    const staleFrame = work.callback;
    action('idle', 21);
    staleFrame(0, { mediaTime: 5.79 });
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['shown', 'move02', 19]);
    assert.equal(work.src, '');
    assert.equal(overlay.hidden, false);
    idle.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    settleBlend();
    assert.deepEqual(frames.at(-1), ['shown', 'idle', 21]);
  });

  await t.test('a one-shot idle variant reloads a parked looping source rather than continuing in the middle', async () => {
    action('work', 22);
    work.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    const loads = idle.loads;
    action('once-idle', 23);
    assert.equal(idle.loads, loads + 1);
    idle.callback(0, { mediaTime: 0 });
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['shown', 'once-idle', 23]);
  });

  await t.test('a finished companion rebound retires its decoder and reports the current generation', async () => {
    const layers = [video(), video()];
    for (const layer of layers) layer.classList.toggle = () => {};
    document.querySelectorAll = () => layers;
    output.setAttribute = () => {};
    boot('companion');
    const [first, next] = layers;
    action('companion-rebound', 1);
    first.dispatch('loadedmetadata');
    first.callback(0, { mediaTime: 3.75 });
    await Promise.resolve();
    action('companion-rebound', 2);
    assert.deepEqual(frames.at(-1), ['shown', 'companion-rebound', 2]);
    first.callback(0, { mediaTime: 5.29 });
    assert.equal(first.paused, true);
    assert.deepEqual(frames.at(-1), ['ended', 'companion-rebound', 2]);
    action('companion-rebound', 3);
    assert.deepEqual(frames.at(-1), ['ended', 'companion-rebound', 2], 'a stopped segment cannot confirm a fresh frame');
    next.dispatch('loadedmetadata');
    next.callback(0, { mediaTime: 3.75 });
    await Promise.resolve();
    assert.deepEqual(frames.at(-1), ['shown', 'companion-rebound', 3]);
    assert.equal(next.paused, false);
  });
});

test('native preview menu, quota refresh and cancellation stay scoped to their owned window', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-video-menu-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await buildPreview(folder);
  const app = Object.assign(new EventEmitter(), { setName() {}, setPath() {}, whenReady: () => Promise.resolve(), quit() {} });
  const ipcMain = new EventEmitter();
  const url = 'pet-video://preview/index.html';
  const hits = [], messages = [], popups = [], queries = [], killed = [];
  const area = { x: 0, y: 0, width: 1000, height: 1000 };
  let cursor, win;
  class PreviewWindow extends EventEmitter {
    constructor(bounds) {
      super();
      win = this; this.bounds = bounds;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url }, setWindowOpenHandler() {}, send(...args) { messages.push(args); } });
    }
    isDestroyed() { return !!this.closed; }
    setIgnoreMouseEvents(ignore) { hits.push(ignore); }
    getBounds() { return this.bounds; }
    showInactive() { this.visible = true; }
    isVisible() { return this.visible; }
    async loadURL() {}
    close() { this.closed = true; this.emit('closed'); }
  }
  cursor = { x: 900, y: 900 };
  const electron = { app, ipcMain, BrowserWindow: PreviewWindow,
    protocol: { registerSchemesAsPrivileged() {} },
    screen: Object.assign(new EventEmitter(), { getCursorScreenPoint: () => cursor, getDisplayNearestPoint: () => ({ workArea: area }) }),
    session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, protocol: { handle() {} } }) },
    Menu: { setApplicationMenu() {}, buildFromTemplate(items) { return { popup(options) { popups.push({ items, options }); } }; } },
  };
  const require = createRequire(import.meta.url);
  runInNewContext(await readFile(join(folder, 'main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === 'node:child_process' ? { spawn(command, args, options) {
      const child = Object.assign(new EventEmitter(), { pid: 678 + queries.length, stdout: new EventEmitter() });
      queries.push({ command, args, options, child });
      return child;
    } } : require(name), __dirname: folder,
    console, performance, setTimeout, clearTimeout, AbortController, Buffer, setInterval: () => 1, clearInterval() {},
    process: { env: { PATH: '/usr/bin' }, kill(pid, signal) { killed.push([pid, signal]); } },
  });
  await waitForWindow(() => win?.isVisible());
  const owner = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const name = 'pet-video:context-menu';
  ipcMain.emit(name, owner);
  assert.equal(popups.length, 0); // Click-through.
  ipcMain.emit('pet-video:hit', owner, true);
  ipcMain.emit(name, { ...owner, senderFrame: { url } });
  ipcMain.emit(name, owner, 'extra');
  cursor = { x: 12, y: 12 };
  ipcMain.emit(name, owner);
  assert.equal(popups.length, 0);
  cursor = { x: 900, y: 900 };
  ipcMain.emit('pet-video:gesture', owner, 'begin');
  ipcMain.emit(name, owner);
  assert.equal(popups.length, 0); // Do not interrupt a held left drag.
  ipcMain.emit('pet-video:gesture', owner, 'cancel');
  ipcMain.emit('pet-video:hit', owner, true);
  messages.length = 0;
  ipcMain.emit(name, owner);
  ipcMain.emit(name, owner);
  assert.equal(popups.length, 1);
  assert.equal(popups[0].options.window, win);
  const { items } = popups[0];
  const lookup = items.find(item => item.label === '查询额度');
  assert.equal(typeof lookup.click, 'function');
  assert.deepEqual(messages, [['pet-video:menu-state', true]]); // Opening the menu doesn't change clips.
  items.find(item => item.label === '播放工作动作').click();
  items.find(item => item.label === '回到待机').click();
  assert.deepEqual(messages.slice(1), [['pet-video:action', 'work', 2], ['pet-video:action', 'idle', 3]]);
  popups[0].options.callback();
  assert.equal(hits.at(-1), true);
  assert.deepEqual(messages.at(-1), ['pet-video:menu-state', false, 298, 298]);
  ipcMain.emit('pet-video:hit', owner, true);
  ipcMain.emit(name, owner);
  assert.equal(popups.length, 2);
  assert.equal(queries.length, 0);
  ipcMain.emit('pet-video:quota-refresh', owner);
  lookup.click();
  lookup.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries.length, 1);
  assert.equal(queries[0].options.detached, true);
  assert.equal(queries[0].args.at(-1), join(folder, 'quota_source.py'));
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), ['pet-video:quota-state', { kind: 'loading' }]);
  const complete = ({ child }, data) => {
    child.stdout.emit('data', Buffer.from(JSON.stringify(data)));
    child.emit('close', 0);
  };
  complete(queries[0], { kind: 'balance', amount: 12.5, currency: 'EUR' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1)[1].amount, 12.5);
  assert.equal(messages.at(-1)[1].currency, 'EUR');
  popups[1].options.callback();
  ipcMain.emit('pet-video:hit', owner, true);
  ipcMain.emit('pet-video:quota-refresh', { ...owner, senderFrame: { url } });
  ipcMain.emit('pet-video:quota-refresh', owner, 'unexpected');
  ipcMain.emit('pet-video:quota-refresh', owner);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries.length, 2);
  ipcMain.emit('pet-video:quota-close', owner);
  assert.deepEqual(killed, [[-679, 'SIGKILL']]);
  complete(queries[1], { kind: 'balance', amount: 99 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1)[1].kind, 'closed');
  ipcMain.emit('pet-video:quota-open', owner);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries.length, 3);
  items.find(item => item.label === '停止桌宠预览').click();
  assert.deepEqual(killed, [[-679, 'SIGKILL'], [-680, 'SIGKILL']]);
  complete(queries[2], { kind: 'balance', amount: 88 });
  assert.equal(win.isDestroyed(), true);
  assert.equal(ipcMain.listenerCount(name), 0);
});

test('owned preview advances a real release while decode is pending and keeps it through right-click', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pet-video-drag-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await buildPreview(folder);
  let win, now = 0, loop, cursor = { x: 800, y: 880 };
  const sent = [], popups = [];
  const area = { x: 0, y: 0, width: 1000, height: 1000 };
  const ipcMain = new EventEmitter();
  const app = Object.assign(new EventEmitter(), { setName() {}, setPath() {}, whenReady: async () => {}, quit() {} });
  class PreviewWindow extends EventEmitter {
    constructor(bounds) {
      super(); win = this; this.bounds = bounds;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'pet-video://preview/index.html' },
        setWindowOpenHandler() {}, send(...message) { sent.push(message); } });
    }
    isDestroyed() { return this.closed; }
    setIgnoreMouseEvents() {}
    getBounds() { return this.bounds; }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
    showInactive() { this.visible = true; }
    isVisible() { return this.visible; }
    async loadURL() {}
    close() { this.closed = true; this.emit('closed'); }
  }
  const electron = { app, ipcMain, BrowserWindow: PreviewWindow, protocol: { registerSchemesAsPrivileged() {} },
    screen: Object.assign(new EventEmitter(), { getCursorScreenPoint: () => cursor, getDisplayNearestPoint: () => ({ workArea: area }) }),
    session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, protocol: { handle() {} } }) },
    Menu: { setApplicationMenu() {}, buildFromTemplate(items) { return { popup(options) { popups.push({ items, options }); } }; } },
  };
  const require = createRequire(import.meta.url);
  runInNewContext(await readFile(join(folder, 'main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === 'node:child_process' ? { spawn() { assert.fail('no quota while airborne'); } } : require(name),
    __dirname: folder, performance: { now: () => now }, console, setTimeout, clearTimeout,
    setInterval(fn) { loop = fn; return 1; }, clearInterval() { loop = undefined; },
  });
  await waitForWindow(() => win?.isVisible());
  const target = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const emit = (channel, ...args) => ipcMain.emit(`pet-video:${channel}`, target, ...args);
  emit('reduced-motion', false);
  emit('hit', true);
  emit('gesture', 'begin');
  now = 36; cursor = { x: 800, y: 868 };
  emit('gesture', 'move');
  const lastMove = win.getBounds().y;
  now = 60; cursor = { x: 859, y: 821 };
  emit('gesture', 'release');
  assert.equal(win.getBounds().y, lastMove - 47, 'final native cursor location is not lost');
  const release = sent.find(message => message[0] === 'pet-video:action' && message[1].startsWith('release-'));
  assert.ok(release);
  const drop = { ...win.getBounds() };
  now = 92; loop(); // No renderer 'shown' yet.
  assert.ok(win.bounds.y < drop.y);
  emit('frame', 'failed', release[1], release[2] - 1); // Same clip, wrong generation.
  assert.deepEqual(sent.filter(message => message[0] === 'pet-video:action').at(-1), release);
  emit('hit', true);
  emit('context-menu');
  assert.equal(popups.length, 1);
  win.emit('blur'); // Native menu can change focus.
  popups[0].items.find(item => item.label === '查询额度').click();
  popups[0].items.find(item => item.label === '播放工作动作').click();
  const yBefore = win.bounds.y;
  now = 120; loop();
  assert.ok(win.bounds.y < yBefore);
  assert.deepEqual(sent.filter(message => message[0] === 'pet-video:action').at(-1), release);
  electron.screen.emit('display-metrics-changed');
  assert.deepEqual(sent.filter(message => message[0] === 'pet-video:action').at(-1), release);
  area.x = -1300;
  area.width = 800;
  electron.screen.emit('display-removed');
  assert.deepEqual(sent.filter(message => message[0] === 'pet-video:action').at(-1), ['pet-video:action', 'idle', release[2] + 1]);
  assert.equal(win.bounds.x, -850); // rightmost nominal x=-780, with 70px visual padding
  win.close();
  assert.equal(electron.screen.listenerCount('display-removed'), 0);
  assert.equal(loop, undefined);
  assert.equal(ipcMain.listenerCount('pet-video:gesture'), 0);
});

test('owned workspace windows reveal only after their current idle frame and clean up independently', async () => {
  const { build } = await import('esbuild');
  const compiled = await build({ entryPoints: ['apps/desktop/src/video-preview/video-window.ts'], bundle: true,
    write: false, platform: 'node', format: 'cjs', external: ['electron'] });
  const url = 'pet-video://preview/index.html';
  const windows = [], menus = [], outcomes = [], fullscreen = new Set(), drops = [];
  const ipcMain = new EventEmitter();
  let cursor = { x: 700, y: 700 };
  const screen = Object.assign(new EventEmitter(), { getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 1000 } }) });
  class BrowserWindow extends EventEmitter {
    constructor(bounds) {
      super(); this.bounds = bounds; this.visible = bounds.show; this.messages = [];
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url }, setWindowOpenHandler() {},
        send: (...args) => this.messages.push(args) });
      windows.push(this);
    }
    isDestroyed() { return !!this.closed; }
    isVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
    setBounds(bounds) { this.bounds = bounds; }
    hide() { this.visible = false; this.emit('hide'); }
    setIgnoreMouseEvents() {}
    showInactive() { if (this.failShow) throw new Error('synthetic_show_failure'); this.visible = true; this.emit('show'); }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    destroy() { this.closed = true; this.emit('closed'); }
  }
  const electron = { BrowserWindow, ipcMain, screen, Menu: { buildFromTemplate(items) { return { popup(options) { menus.push({ items, options }); } }; } } };
  const module = { exports: {} };
  const nodeRequire = createRequire(import.meta.url);
  const timers = new Set();
  let now = 100, wall = 1_000_000;
  runInNewContext(compiled.outputFiles[0].text, { module, Buffer, performance: { now: () => now }, Date: { now: () => wall },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    setTimeout, clearTimeout,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    require: id => id === 'electron' ? electron : nodeRequire(id) });
  const { createVideoWindow } = module.exports;
  const open = (prefs = {}, extra = {}) => createVideoWindow({ folder: '/synthetic/bundle', localSession: {}, slot: windows.length,
    preferences: { size: 240, hideInFullscreen: true, movement: true, scheduledActivity: false, ...prefs }, quotaEnabled: false,
    ended: value => outcomes.push(value), onDrop: value => drops.push(value),
    observeFullscreen: callback => { fullscreen.add(callback); return () => fullscreen.delete(callback); }, ...extra });
  const owner = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const frame = (window, clip, generation, event = owner(window), kind = 'shown') => ipcMain.emit('pet-video:frame', event, kind, clip, generation);
  const openMenu = window => {
    cursor = { x: window.bounds.x + 100, y: window.bounds.y + 100 };
    const prior = menus.length;
    ipcMain.emit('pet-video:hit', owner(window), true);
    ipcMain.emit('pet-video:context-menu', owner(window));
    assert.equal(menus.length, prior + 1);
    return menus.at(-1);
  };
  const item = (items, label) => {
    const found = items.find(entry => entry.label === label);
    assert.ok(found, label);
    return found;
  };
  const first = open(), second = open();
  const [one, two] = windows;
  assert.equal(one.visible, false);
  assert.equal(two.visible, false);
  frame(one, 'idle', 1); // before load
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(one.visible, false);
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'idle', 1]);
  frame(one, 'idle', 1, { ...owner(one), senderFrame: { url } });
  frame(one, 'work', 1);
  frame(one, 'idle', 0);
  assert.equal(one.visible, false);
  for (const update of fullscreen) update(true);
  frame(one, 'idle', 1);
  assert.equal(await first.ready, true);
  assert.equal(one.visible, false);
  assert.equal(first.setVisible(true), true);
  assert.equal(one.visible, false);
  for (const update of fullscreen) update(false);
  assert.equal(one.visible, true);
  assert.equal(two.visible, false);
  assert.equal(first.setVisible(false), true);
  for (const update of fullscreen) { update(true); update(false); }
  assert.equal(one.visible, false);
  assert.equal(first.applyDisplay({ size: 256, hideInFullscreen: false }), true);
  assert.equal(one.bounds.width, 384);
  assert.deepEqual(drops, []);
  assert.equal(first.setVisible(true), true);
  for (const update of fullscreen) update(true);
  assert.equal(one.visible, true);
  ipcMain.emit('pet-video:reduced-motion', owner(one), false);
  const task = (startSerial, duration = 6000) => ({ state: 'working', startSerial, expiresAt: wall + duration });
  assert.equal(second.applyTaskAnimation(task(1)), false); // Unconfirmed window.
  assert.equal(first.applyTaskAnimation(task(0)), true);
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work02', 2]);
  ipcMain.emit('pet-video:frame', owner(one), 'ended', 'idle', 1); // Late frames do not advance work.
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work02', 2]);
  ipcMain.emit('pet-video:frame', owner(one), 'ended', 'work02', 2);
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work03', 3]);
  const workMenu = openMenu(one);
  assert.equal(workMenu.items.some(item => item.label === '查询额度'), false);
  assert.equal(item(item(workMenu.items, '桌宠大小').submenu, '100%（256 × 256）').checked, true);
  assert.equal(item(workMenu.items, '全屏时自动隐藏').checked, false);
  const workPreviews = item(item(workMenu.items, '动作预览').submenu, '工作差分动画').submenu;
  item(workPreviews, '收到任务').click();
  assert.deepEqual(one.messages.at(-1), ['pet-video:menu-state', true]);
  workMenu.options.callback();
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work', 4]);
  first.applyTaskAnimation(task(2));
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work', 4]); // Manual work has its own generation.
  ipcMain.emit('pet-video:frame', owner(one), 'ended', 'work', 4);
  for (const tick of [...timers]) tick();
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work', 6]); // Only after manual pose ends.
  first.applyTaskAnimation(task(3));
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work', 6]); // Don't treat reveal of the same active clip as a replay.
  ipcMain.emit('pet-video:frame', owner(one), 'ended', 'work', 6);
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'work', 7]);
  first.setVisible(false);
  first.applyTaskAnimation(task(4, 30));
  assert.equal(timers.size, 0);
  now += 30; wall -= 5000; // Accepted leases do not depend on subsequent wall clock changes.
  first.setVisible(true);
  assert.deepEqual(one.messages.at(-1), ['pet-video:action', 'idle', 8]);
  first.applyTaskAnimation(task(5));
  assert.equal(timers.size, 1);
  assert.equal(first.stop(), true);
  frame(one, 'idle', 1);
  assert.equal(two.closed, undefined);
  two.failShow = true;
  for (const update of fullscreen) update(false);
  frame(two, 'idle', 1);
  assert.equal(await second.ready, false);
  assert.equal(second.stop(), true);
  assert.deepEqual(outcomes, ['stopped', 'failed']);

  const active = open({ scheduledActivity: true, x: 100, y: 400 });
  const moving = windows[2];
  const lastAction = () => moving.messages.filter(([channel]) => channel === 'pet-video:action').at(-1);
  const tick = () => { for (const fn of [...timers]) fn(); };
  const travelFrame = (gen, time, sender = owner(moving)) => ipcMain.emit('pet-video:travel-frame', sender, gen, time);
  await new Promise(resolve => setImmediate(resolve));
  ipcMain.emit('pet-video:reduced-motion', owner(moving), false);
  for (const update of fullscreen) update(false);
  frame(moving, 'idle', 1);
  assert.equal(await active.ready, true);
  now += 19_999; tick();
  assert.deepEqual(lastAction(), ['pet-video:action', 'idle', 1]);
  now += 1; tick();
  assert.deepEqual(lastAction(), ['pet-video:action', 'full-move02', 2]);
  const before = moving.bounds.x;
  travelFrame(2, 6125); // No decoded first frame yet.
  frame(moving, 'full-move02', 1);
  travelFrame(2, 6125);
  assert.equal(moving.bounds.x, before);
  frame(moving, 'full-move02', 2);
  travelFrame(1, 6125);
  travelFrame(2, 6125, owner(two));
  travelFrame(2, Infinity);
  travelFrame(2, 4749); // Intro stays put.
  assert.equal(moving.bounds.x, before);
  travelFrame(2, 6125);
  assert.equal(moving.bounds.x, before + 162);
  assert.equal(active.applyBehavior({ scheduledActivity: true, movement: true }), true);
  assert.deepEqual(lastAction(), ['pet-video:action', 'full-move02', 2]);
  travelFrame(2, 5000); // Backward media time cannot reverse the trajectory.
  assert.equal(moving.bounds.x, before + 162);
  active.applyTaskAnimation(task(1));
  assert.equal(lastAction()[1], 'work');
  travelFrame(2, 7500);
  assert.equal(moving.bounds.x, before + 162);
  assert.deepEqual(drops, []);
  active.applyTaskAnimation({ state: 'idle', startSerial: 0, expiresAt: 0 });
  frame(moving, 'idle', lastAction()[2]);
  now += 20_000; tick();
  const interrupted = lastAction();
  assert.equal(interrupted[1], 'full-move02left');
  frame(moving, interrupted[1], interrupted[2]);
  assert.equal(active.setVisible(false), true);
  travelFrame(interrupted[2], 5250);
  assert.equal(moving.bounds.x, before + 162);
  assert.deepEqual(drops, []);
  assert.equal(active.setVisible(true), true);
  frame(moving, 'idle', lastAction()[2]);
  active.applyTaskAnimation(task(2));
  cursor = { x: moving.bounds.x + 120, y: moving.bounds.y + 140 };
  const gesture = action => ipcMain.emit('pet-video:gesture', owner(moving), action);
  ipcMain.emit('pet-video:hit', owner(moving), true);
  gesture('begin');
  now += 60;
  cursor = { x: cursor.x + 75, y: cursor.y - 40 };
  gesture('move');
  now += 5;
  gesture('release');
  const release = lastAction();
  assert.match(release[1], /^release-/);
  assert.equal(drops.length, 1);
  const releasedX = moving.bounds.x;
  active.applyBehavior({ scheduledActivity: false, movement: true });
  now += 32; tick();
  assert.deepEqual(lastAction(), release);
  assert.ok(moving.bounds.x > releasedX);
  assert.equal(drops.length, 1);
  assert.equal(active.stop(), true);
  assert.equal(ipcMain.listenerCount('pet-video:travel-frame'), 0);
  assert.equal(fullscreen.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(ipcMain.listenerCount('pet-video:frame'), 0);
  assert.equal(screen.listenerCount('display-removed'), 0);

  let cancelled = 0;
  const cues = [];
  const fourth = open({}, {
    quotaEnabled: true,
    quotaSource: { request: () => () => { cancelled++; }, drain: async () => {} },
    lines: { '01': '合成台词' }, onCue: (text, token) => cues.push([text, token]),
  });
  const pet = windows[3];
  await new Promise(resolve => setImmediate(resolve));
  ipcMain.emit('pet-video:reduced-motion', owner(pet), false);
  for (const update of fullscreen) update(false);
  frame(pet, 'idle', 1);
  assert.equal(await fourth.ready, true);
  fourth.applyTaskAnimation(task(1));
  frame(pet, 'work', 2);
  const caption = pet.messages.find(([channel]) => channel === 'pet-video:caption');
  assert.ok(caption, JSON.stringify(pet.messages));
  const [, token, text] = caption;
  assert.equal(typeof text, 'string');
  ipcMain.emit('pet-video:caption-shown', owner(two), token);
  ipcMain.emit('pet-video:caption-shown', owner(pet), token + 1);
  ipcMain.emit('pet-video:caption-shown', owner(pet), token, 'untrusted text');
  assert.deepEqual(cues, []);
  ipcMain.emit('pet-video:caption-shown', owner(pet), token);
  assert.deepEqual(cues, [[text, token]]);
  const quotaMenu = openMenu(pet);
  quotaMenu.options.callback(); // Some native backends report dismissal before click.
  item(quotaMenu.items, '查询额度').click();
  assert.deepEqual(cues, [[text, token], [undefined, token]]);
  assert.ok(pet.messages.some(([channel, clip]) => channel === 'pet-video:action' && clip === 'quota'));
  assert.equal(fourth.setVisible(false), true);
  assert.equal(cancelled, 1);
  assert.equal(fourth.stop(), true);
  assert.equal(ipcMain.listenerCount('pet-video:caption-shown'), 0);
  assert.equal(ipcMain.listenerCount('pet-video:quota-open'), 0);

  const intents = [];
  const fifth = open({ scheduledActivity: false, movement: false, x: 100, y: 400 }, { onMenu: value => intents.push(value) });
  const manual = windows[4];
  await new Promise(resolve => setImmediate(resolve));
  for (const update of fullscreen) update(false);
  frame(manual, 'idle', 1);
  assert.equal(await fifth.ready, true);
  const settingsMenu = openMenu(manual);
  const resize = item(item(settingsMenu.items, '桌宠大小').submenu, '75%（192 × 192）');
  resize.click();
  assert.equal(intents.length, 0);
  settingsMenu.options.callback();
  assert.deepEqual(JSON.parse(JSON.stringify(intents)), [{ kind: 'size', value: 192 }]);
  ipcMain.emit('pet-video:reduced-motion', owner(manual), false);
  const travelMenu = openMenu(manual);
  const directions = menu => item(item(menu.items, '自主活动').submenu, '走路 / 跑步 / 飞行');
  assert.equal(directions(travelMenu).enabled, true); // Explicit preview ignores the two automatic preferences.
  item(directions(travelMenu).submenu, '跑步（向右）').click();
  travelMenu.options.callback();
  assert.deepEqual(manual.messages.at(-1), ['pet-video:action', 'full-move02', 2]);
  frame(manual, 'full-move02', 2);
  const start = manual.bounds.x;
  travelFrame(2, 6125, owner(manual));
  assert.ok(manual.bounds.x > start);
  const lastX = manual.bounds.x;
  fifth.applyTaskAnimation(task(1));
  travelFrame(2, 7500, owner(manual));
  assert.equal(manual.bounds.x, lastX); // A new task cancels only this explicit travel, not any release spring.
  assert.equal(drops.length, 1);
  const blocked = openMenu(manual);
  assert.equal(directions(blocked).enabled, false);
  item(directions(blocked).submenu, '跑步（向右）').click(); // Even a late click is gated at execution.
  blocked.options.callback();
  assert.equal(manual.messages.filter(([channel, clip]) => channel === 'pet-video:action' && clip === 'full-move02').length, 1);
  assert.equal(fifth.stop(), true);

  const companion = open({ x: 190, y: 400 }, { idleOnly: true, companionClips: ['companion-wave', 'companion-stretch', 'companion-juggle', 'companion-hover', 'companion-jump'], quotaEnabled: undefined });
  const whale = windows[5];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(whale.webContents.mainFrame.url, 'pet-video://companion/index.html');
  assert.equal(whale.visible, false);
  for (const update of fullscreen) update(false);
  frame(whale, 'work', 1);
  assert.equal(whale.visible, false);
  frame(whale, 'idle', 1);
  assert.equal(await companion.ready, true);
  assert.equal(whale.visible, true);
  ipcMain.emit('pet-video:reduced-motion', owner(whale), false);
  assert.equal(companion.applyTaskAnimation(task(2)), false);
  assert.equal(companion.applyBehavior({ scheduledActivity: true, movement: true }), false);
  const companionMenu = openMenu(whale);
  assert.deepEqual(Array.from(companionMenu.items, item => item.label).filter(Boolean), ['隐藏桌宠', '全屏时自动隐藏', '桌宠大小', '动作预览', '回到待机', '停止该桌宠']);
  const actions = item(companionMenu.items, '动作预览');
  assert.deepEqual(Array.from(actions.submenu, group => group.label), ['互动', '日常', '玩耍', '拖拽反馈']);
  assert.deepEqual(Array.from(item(actions.submenu, '互动').submenu, entry => entry.label), ['元气挥手', '开心跃动']);
  item(item(actions.submenu, '互动').submenu, '元气挥手').click();
  companionMenu.options.callback();
  const whaleAction = () => whale.messages.filter(([channel]) => channel === 'pet-video:action').at(-1).slice(1);
  assert.deepEqual(whaleAction(), ['companion-wave', 2]);
  frame(whale, 'companion-wave', 2, owner(whale), 'ended');
  assert.deepEqual(whaleAction(), ['idle', 3]);
  ipcMain.emit('pet-video:hit', owner(whale), true);
  ipcMain.emit('pet-video:gesture', owner(whale), 'begin');
  now += 70; cursor = { x: cursor.x + 15, y: cursor.y };
  ipcMain.emit('pet-video:gesture', owner(whale), 'move');
  assert.deepEqual(whaleAction(), ['companion-hover', 4]);
  frame(whale, 'companion-hover', 4, owner(whale), 'failed');
  assert.deepEqual(whaleAction(), ['companion-hover', 4], 'a current failure cannot replace a drag-protected pose');
  ipcMain.emit('pet-video:gesture', owner(whale), 'release');
  assert.deepEqual(whaleAction(), ['idle', 5]);
  ipcMain.emit('pet-video:hit', owner(whale), true);
  ipcMain.emit('pet-video:gesture', owner(whale), 'begin');
  now += 70; cursor = { x: cursor.x + 100, y: cursor.y + 45 };
  ipcMain.emit('pet-video:gesture', owner(whale), 'move');
  assert.deepEqual(whaleAction(), ['companion-hover', 6]);
  ipcMain.emit('pet-video:gesture', owner(whale), 'release');
  assert.deepEqual(JSON.parse(JSON.stringify(drops.at(-1))), { x: 305, y: 445 });
  assert.deepEqual(whaleAction(), ['companion-rebound', 7]);
  frame(whale, 'companion-hover', 6, owner(whale), 'ended'); // Old terminal events cannot retire the bounce.
  frame(whale, 'companion-hover', 6, owner(whale), 'failed');
  const releasedBounds = { ...whale.bounds };
  now += 16;
  for (const timer of [...timers]) timer();
  assert.notDeepEqual(whale.bounds, releasedBounds, 'physics advances before the rebound frame is ready');
  assert.deepEqual(whaleAction(), ['companion-rebound', 7]);
  frame(whale, 'companion-rebound', 7, owner(whale), 'ended');
  assert.deepEqual(whaleAction(), ['companion-rebound', 7], 'the rebound remains protected until the spring settles');
  for (let steps = 0; steps < 1000 && whaleAction()[0] !== 'idle'; steps++) {
    now += 16;
    for (const timer of [...timers]) timer();
  }
  assert.deepEqual(whaleAction(), ['idle', 8]);
  ipcMain.emit('pet-video:reduced-motion', owner(whale), true);
  const reducedMenu = openMenu(whale);
  assert.equal(item(reducedMenu.items, '动作预览').enabled, false);
  reducedMenu.options.callback();
  assert.equal(companion.stop(), true);
  assert.equal(ipcMain.listenerCount('pet-video:frame'), 0);

  const idleOnly = open({ x: 190, y: 400 }, { idleOnly: true, companionClips: ['companion-hover'], quotaEnabled: false });
  const noJump = windows[6];
  await new Promise(resolve => setImmediate(resolve));
  frame(noJump, 'idle', 1);
  assert.equal(await idleOnly.ready, true);
  for (const update of fullscreen) update(false);
  const limitedMenu = openMenu(noJump);
  assert.deepEqual(Array.from(item(limitedMenu.items, '动作预览').submenu, group => group.label), ['拖拽反馈']);
  limitedMenu.options.callback();
  cursor = { x: noJump.bounds.x + 100, y: noJump.bounds.y + 100 };
  ipcMain.emit('pet-video:reduced-motion', owner(noJump), false);
  ipcMain.emit('pet-video:hit', owner(noJump), true);
  ipcMain.emit('pet-video:gesture', owner(noJump), 'begin');
  now += 70; cursor = { x: cursor.x + 100, y: cursor.y + 45 };
  ipcMain.emit('pet-video:gesture', owner(noJump), 'move');
  assert.deepEqual(noJump.messages.filter(([channel]) => channel === 'pet-video:action').at(-1).slice(1), ['companion-hover', 2]);
  ipcMain.emit('pet-video:gesture', owner(noJump), 'release');
  assert.deepEqual(noJump.messages.filter(([channel]) => channel === 'pet-video:action').at(-1).slice(1), ['idle', 3]);
  for (let steps = 0; steps < 1000 && noJump.bounds.x > 0; steps++) { now += 16; for (const timer of [...timers]) timer(); }
  assert.equal(idleOnly.stop(), true);

});
