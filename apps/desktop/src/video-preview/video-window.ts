import type { VideoDisplay, VideoMenuIntent } from '../../../app-service/src/workspace-video-protocol.ts';
import { BrowserWindow, ipcMain, Menu, screen, type IpcMainEvent, type Session } from 'electron';
import { join } from 'node:path';
import { windowColors } from '../window-colors';
import { companionURL, previewURL } from './video-role';
import { clampPosition, type Point } from './motion';
import { ActivitySchedule, activityVariants, planTravel, travelPosition, type Activity } from './activity-schedule';
import { DragSchedule } from './drag-schedule';
import type { Movement } from './locomotion';
import { canPreviewPetMotion, workspacePetMenu } from './pet-menu';
import { CaptionSchedule, IdleGreetings, interactionClips, workCaptions, type VideoLines } from './captions';
import { WorkPoseSchedule } from './task-schedule';
import type { TaskAnimation } from '../../../app-service/src/task-animation.ts';
import { type Clip, isClip, isMediaTime, loops, videoIPC } from './playback';
import { createPreviewQuota, createPreviewQuotaSource, type PreviewQuotaSource } from './quota';
import { overscan, paddedSize } from './pose-geometry';

import type { BehaviorPreferences, PetPreferences } from '../../../../packages/contracts/src/pets.ts';

export function createVideoWindow(options: {
  folder: string; localSession: Session; preferences?: PetPreferences; quotaEnabled?: boolean; quotaSource?: PreviewQuotaSource; slot?: number;
  observeFullscreen?: (listener: (active: boolean) => void) => () => void;
  lines?: VideoLines;
  idleOnly?: boolean;
  onCue?: (text: string | undefined, token: number) => void;
  onMenu?: (intent: VideoMenuIntent) => void;
  onDrop?: (position: { x: number; y: number }) => void;
  ended?: (outcome: 'stopped' | 'failed') => void;
}) {
  const cursor = screen.getCursorScreenPoint();
  const { folder, localSession, preferences, ended, idleOnly = false, quotaEnabled = !idleOnly, slot = 0 } = options;
  const playerURL = idleOnly ? companionURL : previewURL;
  let size = { width: preferences?.size ?? 280, height: preferences?.size ?? 280 };
  const saved = preferences?.x !== undefined && preferences.y !== undefined ? { x: preferences.x, y: preferences.y } : undefined;
  const area = screen.getDisplayNearestPoint(saved ? { x: saved.x + size.width / 2, y: saved.y + size.height / 2 } : cursor).workArea;
  const initial = clampPosition(saved ?? { x: area.x + area.width - size.width - 48 - slot * (size.width + 12),
    y: area.y + area.height - size.height - 48 }, size, area);
  let padding = overscan(size.width);
  const edge = paddedSize(size.width);
  const win = new BrowserWindow({ x: initial.x - padding, y: initial.y - padding, width: edge, height: edge, show: false, frame: false, transparent: true,
    backgroundColor: windowColors.transparent, alwaysOnTop: true, resizable: false, fullscreenable: false, acceptFirstMouse: true,
    title: preferences ? '桌边小崽' : '桌边小崽 · 视频预览', webPreferences: { session: localSession,
      preload: join(folder, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, devTools: false },
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  let didFail = false;
  let frameReady = false;
  let sessionVisible = true;
  let hideInFullscreen = preferences?.hideInFullscreen ?? false;
  let fullscreen = options.observeFullscreen ? undefined as boolean | undefined : false;
  const syncVisibility = () => {
    if (win.isDestroyed()) return false;
    if (!frameReady) return true;
    const show = sessionVisible && (!hideInFullscreen || fullscreen === false);
    if (show !== win.isVisible()) {
      if (show) win.showInactive(); else win.hide();
    }
    return win.isVisible() === show;
  };
  let readyDone = false;
  let settle!: (ok: boolean) => void;
  const ready = new Promise<boolean>(resolve => { settle = resolve; });
  const finishReady = (ok: boolean) => { if (!readyDone) { readyDone = true; settle(ok); } };
  const stop = () => {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* The host only releases confirmed stops. */ }
    return win.isDestroyed();
  };
  const failWindow = () => {
    didFail = true;
    finishReady(false);
    if (!win.isDestroyed()) preferences ? stop() : win.close();
  };
  contents.on('render-process-gone', failWindow);
  win.once('closed', () => { finishReady(false); ended?.(didFail ? 'failed' : 'stopped'); });

  let clip: Clip = 'idle';
  let generation = 0;
  let endedWhilePressed = 0;
  let ignored = false;
  let loaded = false;
  let menuOpen = false;
  let menuSerial = 0;
  let reduced = true; // Wait for the owned renderer's system accessibility setting.
  const ignoreMouse = (ignore: boolean) => {
    if (ignore === ignored || win.isDestroyed()) return;
    ignored = ignore;
    win.setIgnoreMouseEvents(ignore, { forward: ignore });
  };
  ignoreMouse(true);
  let poseOwner: 'task' | 'manual' | 'activity' | 'quota' | 'base' = 'base';
  let presentedGeneration = 0;
  let automatic: { plan: Activity; lastAt: number; lastMs: number; manual?: true } | undefined;
  let manualUntil = 0;
  let behavior = { scheduledActivity: !idleOnly && (preferences?.scheduledActivity ?? false), movement: !idleOnly && (preferences?.movement ?? true) };
  const activity = new ActivitySchedule(performance.now(), behavior);
  const position = () => { const { x, y } = win.getBounds(); return { x: x + padding, y: y + padding }; };
  const move = (point: Point) => win.setPosition(point.x - padding, point.y - padding);
  const workArea = (point: Point) => screen.getDisplayNearestPoint(point).workArea;
  const areaForPet = (point: Point) => workArea({ x: point.x + size.width / 2, y: point.y + size.height / 2 });
  const captions = new CaptionSchedule(state => {
    if (!win.isDestroyed()) contents.send(videoIPC.caption, state?.token ?? null, state?.text ?? null);
  }, (text, token) => options.onCue?.(text, token));
  const greetings = new IdleGreetings(performance.now());
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  let cueForFrame: { generation: number; kind: 'task' | 'interaction'; text: string } | undefined;
  const cancelClick = () => { clearTimeout(clickTimer); clickTimer = undefined; };
  function userActivity(now: number) { activity.userActivity(now); greetings.userActivity(now); }
  let workFinished = false;
  function action(next: Clip, owner: typeof poseOwner = 'base') {
    if (!loaded || win.isDestroyed() || idleOnly && (next !== 'idle' || generation > 0)) return;
    automatic = undefined;
    cueForFrame = undefined;
    if (captions.kind === 'task') captions.clear();
    clip = next;
    poseOwner = owner;
    workFinished = false;
    endedWhilePressed = 0;
    contents.send(videoIPC.action, next, ++generation);
  }
  const schedule = new DragSchedule({
    position, size: () => size, workArea, move,
    show: action,
    face(facing) { if (facing && !win.isDestroyed()) contents.send(videoIPC.face, generation, facing); },
    reducedMotion: () => idleOnly || reduced,
    onDrop: options.onDrop,
  });
  if (preferences) schedule.setMovement(behavior.movement);
  function finishDrag(release: boolean) {
    if (!schedule.pressed) return;
    const now = performance.now();
    const result = schedule.finish(now, release);
    userActivity(now);
    if (result === 'click' && options.lines && win.isVisible()) queueSingleClick();
    if (endedWhilePressed === generation && !schedule.protectsPlay) action('idle');
    ignoreMouse(true);
    if (!release) contents.send(videoIPC.resetDrag);
  }
  let loop: ReturnType<typeof setInterval> | undefined;
  function stopMotionLoop() { clearInterval(loop); loop = undefined; }
  function startMotionLoop() { loop ??= setInterval(tickMotion, 16); }
  function tickMotion() {
    if (win.isDestroyed() || !schedule.needsTick) { stopMotionLoop(); return; }
    const now = performance.now();
    const since = schedule.pressedAt;
    // Only genuine pointer moves add samples. The timer can change a held
    // pose or advance a spring, but cannot manufacture release velocity.
    if (since !== undefined && now - since > 20_000) finishDrag(false);
    else schedule.tick(now);
  }
  const ipcCleanup: (() => void)[] = [];
  win.once('closed', () => { for (const cleanup of ipcCleanup.splice(0)) cleanup(); });
  function listen(channel: string, handler: (...args: unknown[]) => void, duringLoad = false) {
    const listener = (event: IpcMainEvent, ...args: unknown[]) => {
      const frame = event.senderFrame;
      if (!win.isDestroyed() && (loaded || duringLoad) && event.sender === contents && frame === contents.mainFrame && frame?.url === playerURL) handler(...args);
    };
    ipcMain.on(channel, listener);
    ipcCleanup.push(() => ipcMain.removeListener(channel, listener));
  }
  function cursorInside(bounds: ReturnType<BrowserWindow['getBounds']>) {
    const mouse = screen.getCursorScreenPoint();
    if (mouse.x >= bounds.x && mouse.y >= bounds.y && mouse.x < bounds.x + bounds.width && mouse.y < bounds.y + bounds.height) return mouse;
  }
  let quotaOpen = false;
  const quota = createPreviewQuota(options.quotaSource ?? createPreviewQuotaSource(folder), state => {
    const wasOpen = quotaOpen;
    quotaOpen = state.kind !== 'closed';
    if (win.isDestroyed()) return;
    if (quotaOpen && !wasOpen) {
      cancelClick();
      captions.clear();
      stopActivity(performance.now());
    }
    if (preferences && quotaOpen && !wasOpen && !reduced && schedule.yieldSettledPose()) action('quota', 'quota');
    if (!quotaOpen && poseOwner === 'quota' && schedule.yieldSettledPose()) action('idle');
    if (win.isVisible() || state.kind === 'closed') contents.send(videoIPC.quotaState, state);
  });
  const canQuery = () => (!preferences || frameReady) && quotaEnabled && !win.isDestroyed() && win.isVisible() && !schedule.protectsPlay;
  const canPoint = () => canQuery() && !menuOpen && !ignored && !!cursorInside(win.getBounds());
  listen(videoIPC.quotaOpen, (...args) => { if (!args.length && canPoint()) quota.request(); });
  listen(videoIPC.quotaRefresh, (...args) => { if (!args.length && canQuery() && !menuOpen) quota.refresh(); });
  listen(videoIPC.quotaClose, (...args) => { if (!args.length) quota.close(); });
  win.once('closed', () => quota.close(false));
  const task = new WorkPoseSchedule();
  let presentationTimer: ReturnType<typeof setInterval> | undefined;
  function stopPresentationTimer() { clearInterval(presentationTimer); presentationTimer = undefined; }
  function queueSingleClick() {
    // Match the native single/double-click split. The quota handler cancels this before querying.
    cancelClick();
    clickTimer = setTimeout(() => {
      clickTimer = undefined;
      if (win.isDestroyed() || !win.isVisible() || schedule.protectsPlay || quotaOpen || menuOpen) return;
      const choices = interactionClips.filter(value => value !== clip && options.lines?.[value]);
      const picked = choices[Math.floor(Math.random() * choices.length)];
      if (!picked || !schedule.yieldSettledPose()) return;
      const text = options.lines![picked]!;
      if (reduced) { captions.show('interaction', text, performance.now()); tickPresentation(); }
      else {
        action(picked, 'manual');
        cueForFrame = { generation, kind: 'interaction', text };
      }
    }, 250);
  }
  listen(videoIPC.captionShown, (...args) => {
    if (args.length !== 1) return;
    const now = performance.now();
    captions.confirm(args[0], frameReady && win.isVisible() && !schedule.protectsPlay && !menuOpen && !quotaOpen &&
      (captions.kind !== 'task' || (task.active(now) && !reduced)), now);
  });
  function stopActivity(now: number) {
    if (!automatic) return;
    if (captions.kind === 'interaction') captions.clear();
    activity.defer(now);
    action('idle');
  }
  function activityGate(now: number, pointerNearby = false) {
    return { visible: win.isVisible(), reduced, task: task.active(now),
      interaction: schedule.protectsPlay || menuOpen || quotaOpen || !!clickTimer || poseOwner === 'manual',
      pointerNearby, ready: presentedGeneration === generation };
  }
  function allowsActivity(run: NonNullable<typeof automatic>, gate: ReturnType<typeof activityGate>) {
    return run.manual ? canPreviewPetMotion(gate, true) : activity.allows(run.plan.kind, gate);
  }
  function tickPresentation() {
    if (!preferences || win.isDestroyed() || !frameReady) { stopPresentationTimer(); return; }
    const now = performance.now();
    captions.expire(now);
    if (poseOwner === 'manual' && (!win.isVisible() || reduced || now >= manualUntil) && schedule.yieldSettledPose()) action('idle');
    const gate = activityGate(now);
    if (captions.kind === 'task' && (!gate.task || reduced || !gate.visible)) captions.clear();
    schedule.setTaskActive(gate.task);
    if (automatic && (!allowsActivity(automatic, gate) || now - automatic.lastAt > (automatic.plan.kind === 'travel' ? 5000 : 15_000))) {
      stopActivity(now);
    }
    const next = task.next(now, { blocked: !gate.visible || gate.interaction || (captions.kind !== undefined && captions.kind !== 'task'),
      reduced, showingWork: poseOwner === 'task', playingOpening: poseOwner === 'task' && clip === 'work', finished: workFinished });
    if (next && schedule.yieldSettledPose()) {
      action(next, next === 'idle' ? 'base' : 'task');
      if (next !== 'idle' && options.lines) cueForFrame = { generation, kind: 'task', text: workCaptions[next] };
    }
    if (activity.due(now) || options.lines && activity.enabled && greetings.due(now)) {
      const origin = position(), cursor = screen.getCursorScreenPoint();
      const pointerNearby = cursor.x >= origin.x - 32 && cursor.x < origin.x + size.width + 32 &&
        cursor.y >= origin.y - 32 && cursor.y < origin.y + size.height + 32;
      const gates = { ...gate, pointerNearby, ready: poseOwner === 'base' && presentedGeneration === generation,
        interaction: gate.interaction || captions.kind !== undefined };
      const greeting = options.lines && activity.enabled ? greetings.next(now, activity.allows('pose', gates) && !pointerNearby && gates.ready) : undefined;
      if (greeting) captions.show('greeting', greeting, now);
      const plan = activity.next(now, { ...gates, interaction: gates.interaction || !!greeting }, { origin, size, area: areaForPet(origin) });
      if (plan && schedule.yieldSettledPose()) {
        action(plan.clip, 'activity');
        automatic = { plan, lastAt: now, lastMs: -1 };
        const text = plan.kind === 'pose' && options.lines?.[plan.clip as keyof VideoLines];
        if (text) cueForFrame = { generation, kind: 'interaction', text };
      }
    }
    if (gate.visible && (gate.task || poseOwner === 'task' || poseOwner === 'manual' || automatic || activity.enabled || captions.kind)) presentationTimer ??= setInterval(tickPresentation, 100);
    else stopPresentationTimer();
  }
  listen(videoIPC.travelFrame, (...args) => {
    const [request, mediaMs] = args, run = automatic;
    if (!run || run.plan.kind !== 'travel' || args.length !== 2 || request !== generation ||
        presentedGeneration !== generation || !isMediaTime(mediaMs) || mediaMs <= run.lastMs) return;
    const now = performance.now();
    if (!allowsActivity(run, activityGate(now))) { stopActivity(now); return; }
    const point = travelPosition(run.plan, mediaMs);
    const current = position();
    if (point.x !== current.x || point.y !== current.y) move(point);
    run.lastAt = now;
    run.lastMs = mediaMs;
  });
  function applyTaskAnimation(value: TaskAnimation) {
    if (idleOnly || !preferences || !frameReady || win.isDestroyed()) return false;
    task.receive(value, Date.now(), performance.now(), reduced);
    tickPresentation();
    return true;
  }
  win.once('closed', () => { stopPresentationTimer(); cancelClick(); captions.clear(); });
  function previewPose(next: Clip) {
    const now = performance.now();
    if (next !== 'idle' && !canPreviewPetMotion({ ...activityGate(now), interaction: schedule.protectsPlay || menuOpen }, false)) return;
    if (!schedule.yieldSettledPose()) return;
    userActivity(now);
    captions.clear();
    action(next, next === 'idle' ? 'base' : 'manual');
    manualUntil = now + 15_000;
    tickPresentation();
  }
  function previewTravel(moveId: Movement) {
    const now = performance.now();
    if (!canPreviewPetMotion({ ...activityGate(now), interaction: schedule.protectsPlay || menuOpen }, true)) return;
    const origin = position();
    const plan = planTravel(moveId, { origin, size, area: areaForPet(origin) });
    if (!plan || !schedule.yieldSettledPose()) return;
    userActivity(now);
    captions.clear();
    action(plan.clip, 'activity');
    automatic = { plan, lastAt: now, lastMs: -1, manual: true };
    tickPresentation();
  }
  const manual = (next: 'work' | 'idle') => {
    if (!schedule.yieldSettledPose()) return;
    userActivity(performance.now());
    captions.clear();
    action(next, next === 'work' ? 'manual' : 'base');
  };
  const work = () => manual('work');
  const idle = () => manual('idle');
  const previewMenu = !preferences ? Menu.buildFromTemplate([
    { label: '播放工作动作', click: work }, { label: '回到待机', click: idle },
    ...(quotaEnabled ? [{ type: 'separator' as const }, { label: '查询额度', click: () => { if (canQuery()) quota.request(); } }] : []),
    { label: preferences ? '停止该桌宠' : '停止桌宠预览', click: () => { if (!win.isDestroyed()) preferences ? stop() : win.close(); } },
  ]) : undefined;
  listen(videoIPC.contextMenu, (...args) => {
    if (args.length || ignored || schedule.pressed || menuOpen || !win.isVisible() || !cursorInside(win.getBounds())) return;
    menuOpen = true;
    const serial = ++menuSerial;
    const now = performance.now();
    userActivity(now);
    cancelClick();
    captions.clear();
    stopActivity(now);
    contents.send(videoIPC.menuState, true);
    let pending: (() => void) | undefined;
    let consumed = false;
    const afterMenu = (run: () => void) => () => {
      if (consumed || serial !== menuSerial || win.isDestroyed() || !win.isVisible() || !frameReady) return;
      consumed = true;
      if (menuOpen) pending = run;
      else run();
    };
    const dismissed = () => {
      if (!menuOpen || serial !== menuSerial) return;
      menuOpen = false;
      if (win.isDestroyed()) return;
      // Resample the new point: the native popup may have swallowed mouse move/leave events.
      ignoreMouse(true);
      const bounds = win.getBounds(), mouse = cursorInside(bounds);
      if (mouse) contents.send(videoIPC.menuState, false, mouse.x - bounds.x, mouse.y - bounds.y);
      else contents.send(videoIPC.menuState, false);
      const run = pending;
      pending = undefined;
      if (win.isVisible()) run?.();
    };
    try {
      const menu = previewMenu ?? Menu.buildFromTemplate(workspacePetMenu({
        size: size.width, hideInFullscreen, ...behavior, reduced, task: task.active(now),
        protectedPose: schedule.protectsPlay, quota: quotaEnabled, idleOnly,
      }, {
        intent: intent => afterMenu(() => {
          if (intent.kind !== 'size' || !schedule.protectsPlay) options.onMenu?.(intent);
        })(),
        pose: next => afterMenu(() => previewPose(next))(),
        travel: movement => afterMenu(() => previewTravel(movement))(),
        perform: afterMenu(() => previewPose(activityVariants[Math.floor(Math.random() * activityVariants.length)]!)),
        idle: afterMenu(() => previewPose('idle')),
        quota: afterMenu(() => { if (canQuery()) quota.request(); }),
        stop: afterMenu(stop),
      }));
      menu.popup({ window: win, callback: dismissed });
    }
    catch { dismissed(); }
  });
  listen(videoIPC.hit, (...args) => {
    if (win.isVisible() && args.length === 1 && typeof args[0] === 'boolean' && !schedule.pressed && !menuOpen) ignoreMouse(!args[0]);
  });
  listen(videoIPC.reducedMotion, (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'boolean') return;
    reduced = args[0];
    tickPresentation();
  }, true);
  listen(videoIPC.gesture, (...args) => {
    if (args.length !== 1) return;
    if (args[0] === 'release' || args[0] === 'cancel') { finishDrag(args[0] === 'release'); return; }
    if (args[0] === 'move') {
      if (schedule.pressed) schedule.move(screen.getCursorScreenPoint(), performance.now());
      return;
    }
    if (args[0] !== 'begin' || schedule.pressed) return;
    const mouse = cursorInside(win.getBounds());
    if (ignored || menuOpen || !mouse || !win.isVisible()) { contents.send(videoIPC.resetDrag); return; }
    quota.close();
    const now = performance.now();
    userActivity(now);
    cancelClick();
    captions.clear();
    stopActivity(now);
    schedule.begin(mouse, now);
    startMotionLoop();
  });
  listen(videoIPC.frame, (...args) => {
    const [event, shown, request] = args;
    if (args.length !== 3 || generation === 0 || !isClip(shown) || shown !== clip || request !== generation) return;
    if (event === 'shown') {
      presentedGeneration = generation;
      const pending = cueForFrame;
      if (pending?.generation === generation) {
        cueForFrame = undefined;
        const now = performance.now();
        if (win.isVisible() && !menuOpen && !quotaOpen && !schedule.protectsPlay &&
            (pending.kind !== 'task' || (task.active(now) && !reduced))) {
          captions.show(pending.kind, pending.text, now);
          tickPresentation();
        }
      }
    }
    if (preferences && !readyDone && shown === 'idle') {
      if (event === 'shown') {
        try {
          frameReady = true;
          activity.defer(performance.now());
          if (!syncVisibility()) throw new Error('video_visibility_unconfirmed');
          finishReady(true);
          tickPresentation();
        }
        catch { failWindow(); }
      } else if (event === 'failed') failWindow();
      return;
    }
    if (poseOwner === 'task' && (event === 'ended' || event === 'failed')) {
      workFinished = true;
      if (event === 'failed') task.failed(performance.now());
      tickPresentation();
    } else if (automatic && (event === 'ended' || event === 'failed')) {
      if (event === 'ended') { activity.defer(performance.now()); action('idle'); }
      else stopActivity(performance.now());
    } else if (event === 'ended' && !loops(shown)) {
      if (schedule.pressed) endedWhilePressed = generation;
      else if (!schedule.protectsPlay) action('idle');
    } else if (event === 'failed' && shown !== 'idle') action('idle');
    else if (event === 'failed' && preferences) failWindow();
  });
  const recoverDisplay = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const bounds = win.getBounds();
    const current = { x: bounds.x + padding, y: bounds.y + padding };
    const center = { x: current.x + size.width / 2, y: current.y + size.height / 2 };
    const safe = clampPosition(current, size, screen.getDisplayNearestPoint(center).workArea);
    if (safe.x === current.x && safe.y === current.y) return;
    // A disappearing work area is not a real release and must not save a position or create velocity.
    finishDrag(false);
    schedule.cancel(performance.now());
    win.setPosition(safe.x - padding, safe.y - padding);
  };
  const displayChanged = () => {
    if (automatic?.plan.kind === 'travel') stopActivity(performance.now());
    recoverDisplay();
  };
  screen.on('display-removed', displayChanged);
  screen.on('display-metrics-changed', displayChanged);
  win.on('show', recoverDisplay);
  win.on('show', () => { activity.defer(performance.now()); tickPresentation(); });
  win.once('closed', () => {
    screen.removeListener('display-removed', displayChanged);
    screen.removeListener('display-metrics-changed', displayChanged);
  });
  win.on('blur', () => finishDrag(false));
  win.on('hide', () => {
    stopPresentationTimer();
    cancelClick();
    captions.clear();
    cueForFrame = undefined;
    stopActivity(performance.now());
    quota.close();
    finishDrag(false);
    schedule.cancel(performance.now());
    if (poseOwner === 'manual') action('idle');
    ignoreMouse(true);
  });
  win.once('closed', stopMotionLoop);
  const offFullscreen = options.observeFullscreen?.(active => {
    fullscreen = active;
    try { if (!syncVisibility()) failWindow(); } catch { failWindow(); }
  });
  if (offFullscreen) win.once('closed', offFullscreen);
  function setVisible(value: boolean) {
    if (!frameReady || win.isDestroyed()) return false;
    const previous = sessionVisible;
    sessionVisible = value;
    try { if (syncVisibility()) return true; } catch { /* Restore session intent on failure. */ }
    sessionVisible = previous;
    try { syncVisibility(); } catch { /* A failed acknowledgement never updates service state. */ }
    return false;
  }
  function applyDisplay(value: VideoDisplay) {
    if (!frameReady || win.isDestroyed()) return false;
    if (value.size === size.width && value.hideInFullscreen === hideInFullscreen) return true;
    const resizing = value.size !== size.width;
    if (resizing && schedule.protectsPlay) return false;
    const previous = { size, padding, hideInFullscreen, bounds: win.getBounds() };
    try {
      if (resizing) {
        const point = { x: previous.bounds.x + padding, y: previous.bounds.y + padding };
        size = { width: value.size, height: value.size };
        padding = overscan(value.size);
        const center = { x: point.x + previous.size.width / 2, y: point.y + previous.size.height / 2 };
        const safe = clampPosition(point, size, screen.getDisplayNearestPoint(center).workArea);
        const width = paddedSize(value.size);
        win.setBounds({ x: safe.x - padding, y: safe.y - padding, width, height: width });
        const bounds = win.getBounds();
        if (bounds.width !== width || bounds.height !== width) throw new Error('video_size_unconfirmed');
        if (automatic?.plan.kind === 'travel') stopActivity(performance.now());
      }
      hideInFullscreen = value.hideInFullscreen;
      if (syncVisibility()) return true;
    } catch { /* Restore when possible and leave the service's last confirmed values intact. */ }
    size = previous.size; padding = previous.padding; hideInFullscreen = previous.hideInFullscreen;
    try { if (resizing) win.setBounds(previous.bounds); syncVisibility(); } catch { /* Still unconfirmed. */ }
    return false;
  }
  function applyBehavior(value: BehaviorPreferences) {
    if (!frameReady || win.isDestroyed() || idleOnly && (value.scheduledActivity || value.movement)) return false;
    if (activity.setPreferences(performance.now(), value)) {
      behavior = { ...value };
      if (!value.scheduledActivity && captions.kind === 'greeting') captions.clear();
      schedule.setMovement(value.movement);
      tickPresentation();
    }
    return true;
  }
  void win.loadURL(playerURL).then(() => {
    if (win.isDestroyed()) return;
    loaded = true;
    if (!preferences) { win.showInactive(); finishReady(true); }
    action('idle');
  }).catch(failWindow);
  const previewClip = (next: Clip) => { if (!preferences && schedule.yieldSettledPose()) action(next); };
  return { ready, stop, work, idle, previewClip, setVisible, applyDisplay, applyBehavior, applyTaskAnimation };
}
