import { useId, useRef, useState, type FormEvent } from 'react';
import { isLiveDanmaku, liveDanmakuMaxLength, type LiveDanmakuError, type LiveDanmakuState } from '../../../../packages/contracts/src/live-stage.ts';
import { ComposerKeyboard } from '../chat-input.ts';
import { PetNookIcon } from '../PetNookIcon.tsx';

const failures: Record<LiveDanmakuError,string> = {
  'no-model': '先在「模型管理」添加并保存一个服务商和模型。',
  'model-failed': '没收到可播的回复，请检查「模型管理」里的第一个服务商后重试。',
  'rate-limit': '演练发送过于频繁，请稍后再试。',
  'speech-failed': '没能合成节目语音，请检查本机语音状态后重试。',
};
export const danmakuWorking = (state?: LiveDanmakuState) => state?.phase === 'generating' || state?.phase === 'synthesizing';

export function LiveDanmaku({ state, notice, available, locked, unavailableHint, onSend }: {
  state?: LiveDanmakuState; notice: string; available: boolean; locked: boolean; unavailableHint: string;
  onSend(text: string): Promise<boolean>;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const keyboard = useRef(new ComposerKeyboard());
  const sending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState('');
  const text = draft.trim();
  const working = danmakuWorking(state);
  const status = notice || (submitting ? '正在提交演练…'
    : state?.phase === 'generating' ? '龙妹正在读弹幕、组织回复。'
    : state?.phase === 'synthesizing' ? '正在用本机音色生成节目语音。'
    : state?.phase === 'failed' ? failures[state.error] : unavailableHint);
  const canSend = available && !locked && !submitting && !working && isLiveDanmaku(text);
  const statusKind = notice || state?.phase === 'failed' ? 'error' : submitting || working ? 'pending' : 'idle';
  const focusInput = () => input.current?.focus({ preventScroll: true });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || sending.current) return;
    sending.current = true;
    // Preserve the editor focus on click or Enter, but never move it after the async reply.
    focusInput();
    setSubmitting(true);
    try {
      if (await onSend(text)) setDraft('');
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  return <section className="live-danmaku" aria-labelledby={`${id}-title`}>
    <header className="live-danmaku-heading">
      <span className="live-danmaku-icon"><PetNookIcon name="chat" /></span>
      <h3 id={`${id}-title`}>弹幕演练</h3>
    </header>
    <form className="live-danmaku-form" onSubmit={event => void submit(event)}>
      <div className="live-danmaku-composer">
        <label className="sr-only" htmlFor={`${id}-text`}>观众弹幕</label>
        <textarea id={`${id}-text`} ref={input} rows={2} maxLength={liveDanmakuMaxLength} value={draft} readOnly={submitting || working}
          placeholder="例如：龙妹，这套布景叫什么？"
          onCompositionStart={() => keyboard.current.start()}
          onCompositionEnd={event => keyboard.current.end(event.timeStamp)}
          onKeyDown={event => {
            const action = keyboard.current.action(event.nativeEvent, canSend, event.timeStamp);
            if (action !== 'send' && action !== 'block') return;
            event.preventDefault();
            if (action === 'send') event.currentTarget.form?.requestSubmit();
          }}
          onChange={event => setDraft(event.currentTarget.value.replace(/[\r\n\t\u2028\u2029]+/g,' '))} />
        <div className="live-danmaku-controls">
          <button type="submit" className="live-danmaku-send" title="发送演练弹幕" aria-label="发送演练弹幕" aria-keyshortcuts="Enter" disabled={!canSend}><PetNookIcon name="send" /></button>
        </div>
      </div>
      {status && <p className="live-danmaku-notice" role="status" data-state={statusKind}>{status}</p>}
    </form>
  </section>;
}
