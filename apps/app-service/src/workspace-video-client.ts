import type { PackageReference } from '../../../packages/contracts/src/pets.ts';
import type { OwnedPlayer, OwnedStatus } from './pet-lifecycle.ts';
import { videoCue, videoDrop, videoMenu, videoReply, type VideoMenuIntent, type VideoCommand, type VideoControl, type VideoPosition, type VideoResult } from './workspace-video-protocol.ts';

const snapshot = (status: OwnedStatus) => ({ status });

type Instance = { status: OwnedStatus; seq: number; onDrop?: (position: VideoPosition) => void;
  source: symbol; lastCue: number; activeCue: number; cancelSpeech?: Promise<void> };
type VideoSpeech = {
  offer(source: symbol, text: string, eligible: () => boolean): void;
  cancelSource(source: symbol): Promise<void>;
};
type Pending = { id: string; settle: (result: VideoResult) => void };

/** The service retains lifecycle ownership; only trusted main can acknowledge a native window. */
export class WorkspaceVideoClient {
  private readonly instances = new Map<string, Instance>();
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private menuHandler?: (id: string, intent: VideoMenuIntent, current: () => boolean) => void;
  setMenuHandler(handler: NonNullable<WorkspaceVideoClient['menuHandler']>) { this.menuHandler = handler; }
  constructor(private readonly send: (command: VideoCommand) => void, private readonly timeout = 7000, private readonly speech?: VideoSpeech) {}

  private revoke(own: Instance) {
    if (!own.activeCue) return;
    own.activeCue = 0;
    const cutoff = this.speech?.cancelSource(own.source);
    if (!cutoff) return;
    const barrier = cutoff.catch(() => {}).finally(() => {
      if (own.cancelSpeech === barrier) own.cancelSpeech = undefined;
    });
    own.cancelSpeech = barrier;
  }

  receive(input: unknown) {
    if (videoMenu(input)) {
      const own = this.instances.get(input.id);
      const current = () => !!own && this.instances.get(input.id) === own && own.seq === input.seq && own.status === 'running';
      if (current()) this.menuHandler?.(input.id, input.intent, current);
      return;
    }
    if (videoCue(input)) {
      const own = this.instances.get(input.id), speech = this.speech;
      if (!speech || !own || own.seq !== input.seq || own.status !== 'running') return;
      if (input.text === null) { if (own.activeCue === input.cue) this.revoke(own); return; }
      if (input.cue <= own.lastCue) return;
      this.revoke(own);
      own.activeCue = own.lastCue = input.cue;
      const eligible = () => this.instances.get(input.id) === own && own.seq === input.seq && own.status === 'running' && own.activeCue === input.cue;
      const text = input.text;
      if (own.cancelSpeech) void own.cancelSpeech.then(() => { if (eligible()) speech.offer(own.source, text, eligible); });
      else speech.offer(own.source, text, eligible);
      return;
    }
    if (videoDrop(input)) {
      const own = this.instances.get(input.id);
      if (own?.seq === input.seq && own.status === 'running') own.onDrop?.({ x: input.x, y: input.y });
      return;
    }
    if (!videoReply(input)) return;
    const own = this.instances.get(input.id);
    if (input.type === 'workspace-video-ended') {
      if (own?.seq === input.seq && own.status === 'running') {
        this.revoke(own);
        own.status = input.result === 'stopped' ? 'stopped' : 'error';
      }
      return;
    }
    const pending = this.pending.get(input.seq);
    if (pending?.id === input.id) pending.settle(input.result);
  }

  controller(id: string, reference: PackageReference): OwnedPlayer {
    const own: Instance = { status: 'stopped', seq: 0, source: Symbol('video-player'), lastCue: 0, activeCue: 0 };
    this.instances.set(id, own);
    const request = (op: { op: 'start'; package: PackageReference; preferences: Parameters<OwnedPlayer['start']>[0] } | { op: 'stop' }) => {
      const previous = this.pending.get(own.seq);
      if (previous) previous.settle('failed');
      this.revoke(own);
      own.lastCue = 0;
      const seq = own.seq = ++this.seq;
      own.status = op.op === 'start' ? 'starting' : 'stopping';
      return new Promise<ReturnType<typeof snapshot>>(resolve => {
        const settle = (result: VideoResult) => {
          clearTimeout(timer);
          this.pending.delete(seq);
          const status = op.op === 'start' && result === 'running' ? 'running' : op.op === 'stop' && result === 'stopped' ? 'stopped' : 'error';
          if (own.seq === seq) own.status = status;
          resolve(snapshot(status));
        };
        const timer = setTimeout(() => settle('failed'), this.timeout);
        this.pending.set(seq, { id, settle });
        try { this.send({ type: 'workspace-video-command', version: 1, id, seq, ...op }); }
        catch { settle('failed'); }
      });
    };
    const control = (op: VideoControl) => {
      if (own.status !== 'running') return Promise.resolve(false);
      const epoch = own.seq, seq = ++this.seq;
      return new Promise<boolean>(resolve => {
        const settle = (result: VideoResult) => {
          clearTimeout(timer);
          this.pending.delete(seq);
          resolve(result === 'applied' && own.status === 'running' && own.seq === epoch);
        };
        const timer = setTimeout(() => settle('failed'), this.timeout);
        this.pending.set(seq, { id, settle });
        try { this.send({ type: 'workspace-video-command', version: 1, id, seq, epoch, ...op }); }
        catch { settle('failed'); }
      });
    };
    return {
      snapshot: () => snapshot(own.status),
      start: preferences => request({ op: 'start', package: { id: reference.id, version: reference.version }, preferences }),
      stop: async () => {
        const result = own.status === 'stopped' ? snapshot('stopped') : await request({ op: 'stop' });
        await own.cancelSpeech;
        return result;
      },
      applyDisplayPreferences: value => control({ op: 'display', value }),
      applyBehaviorPreferences: value => control({ op: 'behavior', value }),
      // The owned window cancels the exact displayed cue on hide (including fullscreen).
      setVisible: value => control({ op: 'visibility', value }),
      applyTaskAnimation: value => {
        if (own.status !== 'running') return;
        // This ephemeral projection needs no in-flight request or renderer acknowledgement.
        try { this.send({ type: 'workspace-video-command', version: 1, id, seq: ++this.seq, epoch: own.seq, op: 'task', value }); }
        catch { /* Rely on the window lease to expire. */ }
      },
      setPositionListener: onDrop => { own.onDrop = onDrop; },
      close: async () => {
        if (own.status !== 'stopped' && (await request({ op: 'stop' })).status !== 'stopped') throw new Error('video_stop_unconfirmed');
        this.revoke(own);
        await own.cancelSpeech;
        if (this.instances.get(id) === own) this.instances.delete(id);
      },
    };
  }
}
