import { parsePreviewQuotaResult } from './quota-result';
import { contextBridge, ipcRenderer } from 'electron';
import type { PreviewBridge } from './bridge';
import { isClip, isGeneration, isMediaTime, videoIPC } from './playback';

const bridge: PreviewBridge = {
  onAction(onClip) {
    ipcRenderer.on(videoIPC.action, (_event, clip: unknown, generation: unknown) => {
      if (isClip(clip) && isGeneration(generation)) onClip(clip, generation);
    });
  },
  onFace(update) {
    ipcRenderer.on(videoIPC.face, (_event, generation: unknown, facing: unknown) => {
      if (isGeneration(generation) && (facing === 'left' || facing === 'right')) update(generation, facing);
    });
  },
  onDragReset(reset) { ipcRenderer.on(videoIPC.resetDrag, () => reset()); },
  onMenuState(update) {
    const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 16384;
    ipcRenderer.on(videoIPC.menuState, (_event, open: unknown, x: unknown, y: unknown) => {
      if (open === true) update(true);
      else if (open === false) update(false, coordinate(x) && coordinate(y) ? { x, y } : undefined);
    });
  },
  openMenu() { ipcRenderer.send(videoIPC.contextMenu); },
  onCaption(update) {
    ipcRenderer.on(videoIPC.caption, (_event, token: unknown, text: unknown) => {
      if (token === null && text === null) update();
      else if (isGeneration(token) && typeof text === 'string' && text.length <= 240 && text.length > 0) update({ token, text });
    });
  },
  captionShown(token) { if (isGeneration(token)) ipcRenderer.send(videoIPC.captionShown, token); },
  onQuota(update) {
    ipcRenderer.on(videoIPC.quotaState, (_event, value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const { queriedAt, ...result } = value as Record<string, unknown>;
      if (Object.keys(result).length === 1 && (result.kind === 'loading' || result.kind === 'closed')) {
        update({ kind: result.kind });
      } else if (typeof queriedAt === 'number' && Number.isSafeInteger(queriedAt) && queriedAt > 0 && queriedAt <= 4102444800000) {
        const parsed = parsePreviewQuotaResult(result);
        if (parsed) update({ ...parsed, queriedAt });
      }
    });
  },
  requestQuota() { ipcRenderer.send(videoIPC.quotaOpen); },
  refreshQuota() { ipcRenderer.send(videoIPC.quotaRefresh); },
  closeQuota() { ipcRenderer.send(videoIPC.quotaClose); },
  hit(opaque) { if (typeof opaque === 'boolean') ipcRenderer.send(videoIPC.hit, opaque); },
  reducedMotion(reduced) { if (typeof reduced === 'boolean') ipcRenderer.send(videoIPC.reducedMotion, reduced); },
  gesture(phase) {
    if (phase === 'begin' || phase === 'move' || phase === 'release' || phase === 'cancel') ipcRenderer.send(videoIPC.gesture, phase);
  },
  travelFrame(generation, mediaMs) {
    if (isGeneration(generation) && isMediaTime(mediaMs)) ipcRenderer.send(videoIPC.travelFrame, generation, mediaMs);
  },
  frame(event, clip, generation) {
    if ((event === 'shown' || event === 'ended' || event === 'failed') && isClip(clip) && isGeneration(generation)) ipcRenderer.send(videoIPC.frame, event, clip, generation);
  },
};
contextBridge.exposeInMainWorld('petVideoPreview', bridge);
