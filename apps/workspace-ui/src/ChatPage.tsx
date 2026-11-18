import { useEffect, useRef } from 'react';
import { ChatComposer } from './ChatComposer.tsx';
import type { ChatWorkspaceState, ChatWorkspaceController, ChatTurn } from './chat-session.ts';
const formatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const replyTimestamp = (time: number, format = formatter): string => format.format(new Date(time));

/** 保留macOS会话布局；默认无在线适配器，不呈现虚构的聊天记录。 */
export function ChatPage({state, controller, onOpenModels}:{state:ChatWorkspaceState;controller?:ChatWorkspaceController;onOpenModels():void}) {
 const {session} = state;
 const name = state.characters.find(character => character.id === state.selectedId)?.name ?? '桌宠';
 const scrollport = useRef<HTMLDivElement>(null);
 const lastId = session.turns.at(-1)?.id;
 useEffect(() => {
  const view = scrollport.current; if (view) view.scrollTop = view.scrollHeight;
 }, [lastId, session.pending, state.selectedId]);
 const blurComposer = (target: EventTarget) => {
  if (target instanceof Element && target.closest('button,select,textarea,a')) return;
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) active.blur();
 };
 return <section className="chat-page" aria-label="聊天">
  <header className="chat-toolbar"><h1 className="sr-only">聊天</h1>
   {state.characters.length > 1 && <select aria-label="聊天角色" value={state.selectedId} onChange={event => controller?.selectCharacter(event.target.value)}>{state.characters.map(character => <option value={character.id} key={character.id}>{character.name}</option>)}</select>}
   <details className="chat-options"><summary aria-label="聊天选项" title="聊天选项">···</summary><div><button type="button" disabled={session.pending || !session.turns.length} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); controller?.requestClear(); }}>清空本轮聊天…</button></div></details>
  </header>
  <div className="chat-scrollport" ref={scrollport} role="region" aria-label="聊天消息列表" tabIndex={0} onClick={event => blurComposer(event.target)}>
   {session.turns.length ? <div className="chat-messages">{session.turns.map(turn => <ChatMessage key={turn.id} turn={turn} />)}{session.pending && <p className="chat-waiting" role="status">等待回复…</p>}</div> :
    <div className="chat-welcome"><svg className="chat-welcome-mark" viewBox="0 0 64 64" aria-hidden="true" fill="currentColor"><path d="M9 35C11 23 20 15 32 16L29 7C38 10 43 15 45 23L53 27C56 28.5 57 31 55 33L49 39L42 38L48 32L39 29C29 26 19 29 9 35Z"/><path d="M12 41C22 34 29 32 37 33L32 39C26 39 20 42 16 46C24 50 33 48 42 43C38 52 29 57 20 54C13 52 9 47 12 41Z"/></svg><h2>今天想和{name}聊点什么？</h2></div>}
  </div>
  <footer className="chat-footer">
   {session.failed && !session.pending && <div className="chat-failure"><span>上一条消息没有得到回复。</span><button type="button" onClick={() => { void controller?.retry(); }}>重试</button><button type="button" disabled={!!session.draft} onClick={() => controller?.restoreDraft()}>恢复输入</button></div>}
   <p className="chat-status" role="status" aria-live="polite">{session.status || (!state.selectedId ? '请先在“我的桌宠”中添加一个角色。' : !state.available ? <><span>模型服务尚未接入，草稿会保留。</span><button type="button" onClick={onOpenModels}>前往模型管理</button></> : '')}</p>
   <ChatComposer state={state} controller={controller} name={name} />
  </footer>
  {session.confirmingClear && <ClearChat onCancel={() => controller?.cancelClear()} onConfirm={() => controller?.confirmClear()} />}
 </section>;
}
function ChatMessage({turn}:{turn:ChatTurn}) {
 return <article className={`chat-message chat-message-${turn.role}`} data-turn-id={turn.id} aria-label={turn.role === 'assistant' ? '助手回复' : '你的消息'}><div className="chat-bubble">{turn.text}</div>{turn.role === 'assistant' && <time dateTime={new Date(turn.createdAt).toISOString()} aria-label={`回复时间 ${replyTimestamp(turn.createdAt)}`}>{replyTimestamp(turn.createdAt)}</time>}</article>;
}
function ClearChat({onCancel,onConfirm}:{onCancel():void;onConfirm():void}) {
 const cancel = useRef<HTMLButtonElement>(null);
 const panel = useRef<HTMLDialogElement>(null);
 useEffect(() => {
  const previous = document.activeElement;
  const dialog = panel.current;
  const fallback = dialog?.closest('.chat-page')?.querySelector<HTMLElement>('.chat-options summary');
  dialog?.showModal();
  cancel.current?.focus();
  return () => {
   dialog?.close();
   if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length) previous.focus();
   else fallback?.focus();
  };
 }, []);
 return <dialog className="chat-clear" ref={panel} role="alertdialog" aria-labelledby="chat-clear-title" aria-describedby="chat-clear-copy" onKeyDown={event => {
  if (event.key !== 'Tab') return;
  const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
  const first = buttons?.[0], last = buttons?.[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
 }} onCancel={event => { event.preventDefault(); onCancel(); }}><h2 id="chat-clear-title">清空本轮聊天？</h2><p id="chat-clear-copy">只清空本轮消息，输入草稿保持不变。</p><div className="button-row"><button type="button" className="button secondary" ref={cancel} onClick={onCancel}>取消</button><button type="button" className="button destructive" onClick={onConfirm}>清空聊天</button></div></dialog>;
}
