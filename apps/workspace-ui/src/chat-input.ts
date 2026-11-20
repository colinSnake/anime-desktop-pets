export type ComposerKey = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean; repeat?: boolean; keyCode: number };
/** 普通编辑交给编辑器；仅接管无修饰 Enter 和 Escape。 */
export class ComposerKeyboard {
 private composing = false;
 private endedAt = -Infinity;
 start() { this.composing = true; }
 end(now: number) { this.composing = false; this.endedAt = now; }
 action(event: ComposerKey, canSend: boolean, now: number): 'native' | 'send' | 'block' | 'blur' {
  if (this.composing || event.isComposing || event.keyCode === 229 || now - this.endedAt < 10) return 'native';
  if (event.key === 'Escape') return 'blur';
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return 'native';
  return canSend && !event.repeat ? 'send' : 'block';
 }
}
