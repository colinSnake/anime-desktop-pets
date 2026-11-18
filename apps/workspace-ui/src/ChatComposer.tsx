import { acceptedChatText } from '../../../packages/contracts/src/online-chat.ts';
import { parseLocalChatCommand } from '../../../packages/contracts/src/local-chat.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { ComposerKeyboard } from './chat-input.ts';
import { characterCount, validatedMessage, type ChatWorkspaceController, type ChatWorkspaceState } from './chat-session.ts';

export function ChatComposer({ state, controller, name }: { state: ChatWorkspaceState; controller?: ChatWorkspaceController; name: string }) {
 const input = useRef<HTMLTextAreaElement>(null);
 const keyboard = useRef(new ComposerKeyboard());
 const [composing, setComposing] = useState(false);
 const { session } = state;
 const count = characterCount(session.draft.trim());
 const intent = parseLocalChatCommand(session.draft);
 const invalidOnlineText = !!state.online && !intent && !!session.draft.trim() && count <= 1200 && !acceptedChatText(session.draft.trim());
 const local = !!intent && intent !== 'invalid';
 const canSend = !!controller && !!state.selectedId && !session.pending && !composing &&
  (intent ? local && state.localAvailable : state.available && !!session.model && !!validatedMessage(session.draft) && !invalidOnlineText);
 useLayoutEffect(() => {
  const field = input.current; if (!field) return;
  const line = parseFloat(getComputedStyle(field).lineHeight);
  field.style.height = 'auto';
  field.style.height = `${Math.max(line * 2, Math.min(field.scrollHeight, line * 7))}px`;
 }, [session.draft, state.selectedId]);
 const send = () => {
  if (keyboard.current.action({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13 }, canSend, performance.now()) === 'send') void controller?.send();
  input.current?.focus();
 };
 return <div className="chat-composer" aria-label="消息输入区">
  <textarea ref={input} rows={2} value={session.draft} disabled={!state.selectedId || !controller} placeholder={`和${name}聊聊……`}
   aria-label="聊天消息" aria-invalid={count > 1200 || invalidOnlineText} aria-describedby={invalidOnlineText ? 'chat-text-boundary' : count > 1000 ? 'chat-character-count' : undefined}
   onChange={event => controller?.edit(event.target.value)}
   onCompositionStart={() => { keyboard.current.start(); setComposing(true); }}
   onCompositionEnd={() => { keyboard.current.end(performance.now()); setComposing(false); }}
   onKeyDown={event => {
    const action = keyboard.current.action({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, canSend, performance.now());
    if (action === 'native') return;
    event.preventDefault();
    if (action === 'blur') event.currentTarget.blur();
    if (action === 'send') void controller?.send();
   }} />
  <div className="chat-composer-actions">
   {invalidOnlineText && <span id="chat-text-boundary" className="chat-counter error" aria-live="polite">超出字节上限或含不支持的字符</span>}
   {count > 1000 && <span id="chat-character-count" className={count > 1200 ? 'chat-counter error' : 'chat-counter'} aria-live="polite">{count}/1200</span>}
   <ChatModelPicker state={state} controller={controller} />
   {session.pending ? <button type="button" className="chat-send" aria-label="停止等待回复" title="停止等待当前回复" onClick={() => controller?.cancel()}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg></button> :
    <button type="button" className="chat-send" disabled={!canSend} aria-label={local && state.localAvailable ? "查询本机资料" : "发送消息"} title={local && state.localAvailable ? "Enter 查询本机资料" : "Enter 发送，Shift+Enter 换行"} onClick={send}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
  </div>
 </div>;
}
function ChatModelPicker({state, controller}:{state:ChatWorkspaceState;controller?:ChatWorkspaceController}) {
 const [open, setOpen] = useState(false);
 const toggle = useRef<HTMLButtonElement>(null);
 const selected = state.models.find(model => model.id === state.session.model);
 const enabled = !!controller && state.models.length > 0 && !state.session.pending;
 return <div className="chat-model-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={event => {
  if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); toggle.current?.focus(); }
 }}>
  <button type="button" className="chat-model-toggle" ref={toggle} disabled={!enabled} aria-haspopup="dialog" aria-expanded={open && enabled} onClick={() => setOpen(!open)} title="仅影响后续文字聊天，不更改全局默认模型">{selected?.name ?? '未配置模型'}<span aria-hidden="true">⌄</span></button>
  {open && enabled && <div className="chat-model-list" role="dialog" aria-label="选择模型"><h2>选择模型</h2><div role="group" aria-label="已保存模型">{state.online && state.models.some(model => model.isDefault) && <button type="button" onClick={() => { controller?.selectModel(''); setOpen(false); toggle.current?.focus(); }}>使用全局默认</button>}{state.models.map(model => <button type="button" key={model.id} disabled={model.ready === false} aria-pressed={model.id === state.session.model} onClick={() => { controller?.selectModel(model.id); setOpen(false); toggle.current?.focus(); }}>{model.name}{model.id === state.session.model && <span aria-hidden="true">✓</span>}</button>)}</div></div>}
 </div>;
}
