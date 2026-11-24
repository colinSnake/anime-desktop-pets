import { credentialLikeText } from '../../../packages/contracts/src/character-records.ts';
import type { ChatSendResult } from '../../../packages/contracts/src/online-chat.ts';
import type { ReplySpeechCommand } from '../../../packages/contracts/src/speech.ts';

export function replySpeechText(text: string): string | undefined {
 if (!text || text.length > 256_000 || /[`<>]|\]\(|(?:https?|file):\/\/|\p{Cf}/iu.test(text) || credentialLikeText(text)) return;
 const plain = text.replace(/\s+/gu, ' ').trim();
 if (!plain || /[\p{Cc}\p{Cs}]/u.test(plain)) return;
 const characters = [...plain];
 return characters.length <= 120 ? plain : `${characters.slice(0, 119).join('').trimEnd()}…`;
}

/** In-memory receipt only; the renderer never supplies text to the speech runtime. */
export class ChatReplySpeech {
 private enabled = false;
 private generation = 0;
 private revision = 0;
 private receipt?: { id: string; text: string; expires: number; timer: ReturnType<typeof setTimeout> };
 private mayPlay = false;
 private stopping?: Promise<boolean>;
 constructor(private readonly send: (command: ReplySpeechCommand) => Promise<boolean>, private readonly now = () => performance.now()) {}
 setEnabled(enabled: boolean) {
  if (this.enabled === enabled) return;
  this.enabled = enabled;
  // Opting in must not attach speech to a request admitted with playback off.
  void this.stop();
 }
 begin(): number { void this.stop(); return this.generation; }
 receive(generation: number, result: ChatSendResult) {
  if (!this.enabled || generation !== this.generation || !result.ok || !result.replayable || result.recovered || result.historyStatus === 'omitted') return;
  const text = replySpeechText(result.text);
  if (!text) return;
  this.clearReceipt();
  const timer = setTimeout(() => this.clearReceipt(), 5_000); timer.unref();
  this.receipt = { id: result.requestID, text, expires: this.now() + 5_000, timer };
 }
 displayed(id: string, eligible = () => true): boolean {
  const receipt = this.receipt;
  if (!this.enabled || receipt?.id !== id) return false;
  this.clearReceipt();
  if (receipt.expires <= this.now() || !eligible() || (this.mayPlay && !this.stopping)) return false;
  const generation = this.generation;
  const publish = () => {
   if (!this.enabled || this.mayPlay || this.generation !== generation || receipt.expires <= this.now() || !eligible()) return;
   this.mayPlay = true;
   void this.command({ revision: ++this.revision, text: receipt.text });
  };
  if (this.stopping) void this.stopping.then(stopped => { if (stopped) publish(); });
  else publish();
  return true;
 }
 stop(): Promise<boolean> {
  ++this.generation;
  this.clearReceipt();
  if (this.stopping) return this.stopping;
  if (!this.mayPlay) return Promise.resolve(true);
  const operation = this.command({ revision: ++this.revision }).then(ok => {
   if (ok) this.mayPlay = false;
   return ok;
  }).finally(() => { if (this.stopping === operation) this.stopping = undefined; });
  return this.stopping = operation;
 }
 private command(command: ReplySpeechCommand): Promise<boolean> {
  try { return this.send(command).catch(() => false); } catch { return Promise.resolve(false); }
 }
 private clearReceipt() { clearTimeout(this.receipt?.timer); this.receipt = undefined; }
}
