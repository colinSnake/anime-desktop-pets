import type { SpeechPreviewCommand, SpeechResult } from '../../../packages/contracts/src/speech.ts';

const unavailable = { ok: false, error: 'unavailable' } as const;
const busy = { ok: false, error: 'busy' } as const;

/** Main-only fence. No renderer-supplied text or revision; stop affects only the fixed preview. */
export class SpeechPreview {
  private revision = 0;
  private active = false;
  private starting = false;
  private blocked = false;
  private stopping?: Promise<boolean>;
  constructor(private readonly send: (command: SpeechPreviewCommand) => Promise<SpeechResult>) {}

  async play(eligible: () => boolean): Promise<SpeechResult> {
    if (!eligible() || this.blocked) return unavailable;
    if (this.starting || this.stopping) return busy;
    this.starting = true;
    this.active = true;
    const revision = ++this.revision;
    try {
      const result = await this.send({ revision, play: true });
      // A higher stop already fenced this request, even if its HTTP response was delayed.
      if (this.revision !== revision) return unavailable;
      if (!eligible() || !result.ok && result.error === 'unavailable') {
        await this.stop(); return unavailable;
      }
      return result;
    } catch {
      if (this.revision === revision) await this.stop();
      return unavailable;
    } finally {
      this.starting = false;
    }
  }

  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    if (!this.active && !this.starting && !this.blocked) return Promise.resolve(true);
    const command: SpeechPreviewCommand = { revision: ++this.revision, play: false };
    const operation = Promise.resolve().then(() => this.send(command)).then(result => result.ok, () => false).then(ok => {
      this.active = false;
      this.blocked = !ok;
      return ok;
    }).finally(() => { if (this.stopping === operation) this.stopping = undefined; });
    return this.stopping = operation;
  }
}
