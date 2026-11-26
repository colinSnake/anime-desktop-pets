import { isLiveSnapshot, liveActions, liveScenes, liveVoiceStartBudgetMs, type LiveAction, type LiveSnapshot } from '../../../../packages/contracts/src/live-stage.ts';
import catalog from '../video-preview/clip-catalog.json';

const stage = document.querySelector<HTMLElement>('#stage')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const idle = document.querySelector<HTMLVideoElement>('#idle')!;
const action = document.querySelector<HTMLVideoElement>('#action')!;
let desk = document.querySelector<HTMLImageElement>('#desk')!;
let room = document.querySelector<HTMLImageElement>('#room')!;
const dialogue = document.querySelector<HTMLElement>('#dialogue')!;
const line = document.querySelector<HTMLElement>('#line')!;
let ready = false, connected = false, closed = false;
let latest = -1, scene: LiveSnapshot['scene'] | undefined;
let placement: LiveSnapshot['placement'];
let desired: LiveSnapshot | undefined, retryBackdropAt = 0;
let cancelBackdrop: (() => void) | undefined;
let playingClip: LiveAction | undefined;
let disposeVoice: (() => void) | undefined;
let disposeAction: (() => void) | undefined;
let admission = new AbortController();

function position(video: HTMLVideoElement, clip: 'idle' | LiveAction, {position: x, scale}: LiveSnapshot['placement'], sceneId: LiveSnapshot['scene']) {
  const core = 624 * scale / 100;
  const { scale: correction, offset } = catalog[clip];
  const floorY = liveScenes.find(item => item.id === sceneId)!.floorY;
  const size = Math.round(core * correction);
  video.style.width = `${size / 19.2}%`;
  video.style.height = `${size / 10.8}%`;
  video.style.left = `${Math.round(x * 19.2 - size / 2 + core * offset[0]!) / 19.2}%`;
  video.style.top = `${Math.round(floorY - size + core * offset[1]!) / 10.8}%`;
}

function stopAction() { disposeAction?.(); }
function retire() {
  connected = ready = false;
  admission.abort(); admission = new AbortController();
  cancelBackdrop?.(); desired = undefined; retryBackdropAt = 0;
  stopAction();
  stage.hidden = true; status.hidden = false; status.textContent = '舞台不可用';
  idle.pause(); idle.removeAttribute('src'); idle.load();
}

/** The callback follows decoded frames sent to the compositor, not just loaded metadata. */
function firstFrame(video: HTMLVideoElement, signal: AbortSignal, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const complete = (ok: boolean) => {
      clearTimeout(timer); video.cancelVideoFrameCallback(frame);
      video.removeEventListener('error', bad); signal.removeEventListener('abort', bad);
      ok ? resolve() : reject(new Error('frame_unavailable'));
    };
    const bad = () => complete(false);
    const timer = setTimeout(bad, timeout);
    const frame = video.requestVideoFrameCallback(() => complete(true));
    video.addEventListener('error', bad, {once:true});
    signal.addEventListener('abort', bad, {once:true});
    if (signal.aborted) return bad();
    void video.play().catch(bad);
  });
}

function connect(snapshot: LiveSnapshot) {
  connected = true; latest = snapshot.generation;
  scene = snapshot.scene; stage.dataset.scene = scene;
  room.src = `${scene}-room.webp`; desk.src = `${scene}-desk.webp`;
  placement = snapshot.placement;
  position(idle, 'idle', placement, snapshot.scene);
  idle.src = 'idle.webm'; idle.muted = true;
  const signal = admission.signal;
  // Keep video eligible for composition during preparation; hide the entire scene visually.
  status.hidden = false; status.textContent = '舞台准备中';
  stage.hidden = false; stage.classList.add('preparing');
  void Promise.all([room.decode(), desk.decode(), firstFrame(idle, signal, 2600)]).then(() => {
    if (signal.aborted) return;
    ready = true; stage.classList.remove('preparing'); status.hidden = true;
  }).catch(() => { if (!signal.aborted) retire(); });
}

/** Keep the last complete scene on air while both layers of the next one decode. */
function updateBackdrop(snapshot: LiveSnapshot) {
  if (desired?.scene !== snapshot.scene) retryBackdropAt = 0;
  desired = snapshot;
  if (!ready || snapshot.scene === scene || cancelBackdrop || performance.now() < retryBackdropAt) return;
  const target = snapshot.scene;
  const nextRoom = new Image(), nextDesk = new Image();
  const clear = () => { clearTimeout(timeout); cancelBackdrop = undefined; };
  const cancel = () => {
    clear(); nextRoom.removeAttribute('src'); nextDesk.removeAttribute('src');
  };
  const failed = () => {
    if (cancelBackdrop !== cancel) return;
    if (desired?.scene === target) retryBackdropAt = performance.now() + 1000;
    cancel();
  };
  const timeout = setTimeout(failed, 2500);
  cancelBackdrop = cancel;
  nextRoom.src = `${target}-room.webp`; nextDesk.src = `${target}-desk.webp`;
  void Promise.all([nextRoom.decode(), nextDesk.decode()]).then(() => {
    if (cancelBackdrop !== cancel) return;
    if (desired?.scene !== target) { cancel(); return; }
    clear();
    for (const [previous, layer] of [[room, nextRoom], [desk, nextDesk]] as const) {
      layer.id = previous.id; layer.alt = ''; layer.draggable = false;
      previous.replaceWith(layer);
    }
    room = nextRoom; desk = nextDesk;
    placement = desired.placement;
    position(idle, 'idle', placement, target);
    if (playingClip) position(action, playingClip, placement, target);
    stage.dataset.scene = scene = target;
  }).catch(failed);
}

function play(clip: LiveAction, snapshot: LiveSnapshot) {
  const remaining = snapshot.remainingMs!;
  if (!ready || remaining < 1400) return;
  const pending = new AbortController();
  // Leave room for the next state poll without discarding ordinary slow media startup.
  const voiceDeadline = performance.now() + Math.min(remaining, liveVoiceStartBudgetMs) - 500;
  let shownAt: number | undefined, endedTimer: ReturnType<typeof setTimeout> | undefined;
  let audio: HTMLAudioElement | undefined, startTimer: ReturnType<typeof setTimeout> | undefined;
  let videoEnded = false;
  const endWhenReady = () => {
    if (disposeAction !== stop || shownAt === undefined || !videoEnded || audio) return;
    clearTimeout(endedTimer);
    endedTimer = setTimeout(stop, Math.max(0, 1300 - (performance.now() - shownAt)));
  };
  const stopVoice = () => {
    if (!audio) return;
    const track = audio;
    audio = undefined; disposeVoice = undefined; clearTimeout(startTimer);
    track.removeEventListener('ended',stopVoice); track.removeEventListener('error',mediaFailed);
    track.pause(); track.removeAttribute('src'); track.load(); track.remove();
    endWhenReady();
  };
  const voiceFailed = (reason: 'media_error' | 'play_rejected' | 'start_timeout') => {
    if (!audio) return; // Ignore errors from a revoked or superseded action.
    console.warn(`[live-stage] voice_${reason}`);
    if (snapshot.reply) stop();
    else stopVoice();
  };
  const mediaFailed = () => voiceFailed('media_error');
  const stop = () => {
    if (disposeAction !== stop) return;
    disposeAction = undefined; playingClip = undefined; pending.abort(); clearTimeout(endedTimer); clearTimeout(expiry);
    stopVoice();
    action.removeEventListener('ended', ended); action.removeEventListener('error', stop);
    idle.hidden = false; if (connected) void idle.play().catch(() => { if (connected && idle.error) retire(); });
    action.hidden = true; dialogue.hidden = true;
    action.pause(); action.removeAttribute('src'); action.load();
  };
  const ended = () => { videoEnded = true; endWhenReady(); };
  const expiry = setTimeout(stop, remaining);
  disposeAction = stop; playingClip = clip;
  if (snapshot.voice) {
    audio = document.createElement('audio');
    audio.hidden = true; audio.preload = 'auto';
    audio.addEventListener('ended',stopVoice,{once:true}); audio.addEventListener('error',mediaFailed,{once:true});
    disposeVoice = stopVoice;
    audio.src = `voice-${snapshot.generation}.wav`;
    stage.append(audio);
  }
  position(action, clip, placement, snapshot.scene); action.muted = true;
  action.src = `${clip}.webm`; action.classList.add('pending'); action.hidden = false;
  action.addEventListener('ended', ended); action.addEventListener('error', stop);
  const reveal = () => {
    if (pending.signal.aborted || !ready) return;
    shownAt = performance.now(); action.classList.remove('pending'); idle.hidden = true;
    dialogue.classList.toggle('agent-reply', snapshot.reply !== undefined);
    line.textContent = snapshot.reply ?? liveActions[clip].line; dialogue.hidden = false;
    endWhenReady();
  };
  void firstFrame(action, pending.signal, Math.min(2300, remaining - 1250)).then(() => {
    if (pending.signal.aborted || !ready) return;
    // Manual cues also work muted. An Agent answer airs only once its matching
    // audio actually starts; a failed program audio startup drops both parts.
    if (!snapshot.reply) reveal();
    const track = audio;
    if (!track) { if (snapshot.reply) stop(); return; }
    const timeLeft = voiceDeadline - performance.now();
    if (timeLeft <= 0) voiceFailed('start_timeout');
    else {
      startTimer = setTimeout(() => voiceFailed('start_timeout'),timeLeft);
      void track.play().then(() => {
        clearTimeout(startTimer);
        if (snapshot.reply && track === audio) reveal();
      },() => voiceFailed('play_rejected'));
    }
  }).catch(stop);
}

async function poll() {
  if (closed) return;
  try {
    const response = await fetch('state.json', {cache:'no-store',redirect:'error',signal:AbortSignal.timeout(disposeVoice ? 900 : 2000)});
    if (!response.ok) throw new Error('not_available');
    const next: unknown = await response.json();
    if (closed) return;
    if (!isLiveSnapshot(next)) throw new Error('bad_snapshot');
    if (!connected) connect(next);
    else {
      if (next.generation < latest) throw new Error('bad_generation');
      updateBackdrop(next);
      if (next.generation > latest) {
        latest = next.generation; stopAction();
        if (next.action) play(next.action, next);
      } else if (!next.action) stopAction();
      else if (!next.voice) disposeVoice?.();
    }
  } catch {
    if (!closed && connected) retire();
    else if (!closed) status.textContent = '舞台不可用';
  }
  if (!closed) setTimeout(() => void poll(), connected ? 250 : 1000);
}
idle.addEventListener('error', () => { if (ready) retire(); });
window.addEventListener('pagehide', () => { closed = true; retire(); }, {once:true});
void poll();
