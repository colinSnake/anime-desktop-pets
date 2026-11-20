import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { PackageReference } from '../../../packages/contracts/src/pets.ts';
import { ChatMemoryCard } from './ChatMemoryCard.tsx';
import { ChatComposer } from './ChatComposer.tsx';
import { PetCover, petArt } from './PetCover.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import type { ChatWorkspaceState, ChatWorkspaceController, ChatTurn, LocalChatShortcut } from './chat-session.ts';

const formatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
export const replyTimestamp = (time: number, format = formatter): string => format.format(new Date(time));
const shortcuts = [
 { text: '你是谁', label: '你是谁？', icon: 'identity' },
 { text: '查看目标进度', label: '查看目标进度', icon: 'goals' },
 { text: '查角色知识：', label: '查角色知识', icon: 'memory' },
 { text: '查个人记忆：', label: '查个人记忆', icon: 'search' },
] as const;

type ChatPageProps = {
 state: ChatWorkspaceState;
 controller?: ChatWorkspaceController;
 reference?: PackageReference;
 appearance?: ReactNode;
 onOpenPets?: () => void;
 onOpenPetAgent?: (opener: HTMLElement) => void;
};

export function ChatPage({ state, controller, reference, appearance, onOpenPets, onOpenPetAgent }: ChatPageProps) {
 useEffect(() => { void controller?.refreshModels(); }, [controller]);
 const { session } = state;
 const character = state.characters.find(item => item.id === state.selectedId);
 const scrollport = useRef<HTMLDivElement>(null);
 const input = useRef<HTMLDivElement>(null);
 const options = useRef<HTMLDetailsElement>(null);
 const lastId = session.turns.at(-1)?.id;
 useEffect(() => {
  const view = scrollport.current; if (view) view.scrollTop = view.scrollHeight;
 }, [lastId, session.pending, state.selectedId]);
 useEffect(() => {
  const dismiss = (event: PointerEvent) => {
   if (options.current?.open && event.target instanceof Node && !options.current.contains(event.target)) options.current.open = false;
  };
  document.addEventListener('pointerdown', dismiss);
  return () => document.removeEventListener('pointerdown', dismiss);
 }, []);
 const fill = (text: LocalChatShortcut) => {
  controller?.prefillLocalShortcut(text);
  input.current?.focus();
 };
 const hasTurns = !!session.turns.length || session.pending;
 const today = new Date().toDateString();
 return <section className="chat-page" aria-label="聊天" data-pet-art={petArt(reference)}>
  <header className="chat-toolbar">
   <div><h1>聊天</h1><p>和桌边的伙伴说说话。</p></div>
   <div className="chat-toolbar-actions">
    {character && <div className="chat-role chat-control">
     <ChatAvatar reference={reference} />
     {state.characters.length > 1 ? <>
      <span className="chat-role-name" aria-hidden="true">{character.name}</span><PetNookIcon name="down" />
      <select aria-label="聊天角色" title={character.name} value={character.id} disabled={!controller} onChange={event => controller?.selectCharacter(event.target.value)}>
       {state.characters.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select>
     </> : <span className="chat-role-name">{character.name}</span>}
    </div>}
    {appearance}
    {character && <details className="chat-options" ref={options} onKeyDown={event => {
     if (event.key === 'Escape' && event.currentTarget.open) {
      event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus();
     }
    }}>
     <summary className="chat-control" aria-label="聊天选项" title="聊天选项"><PetNookIcon name="more" /></summary>
     <div className="chat-options-popover">
     {onOpenPetAgent && <button type="button" aria-haspopup="dialog" onClick={() => {
      if (options.current) options.current.open = false;
      const opener = options.current?.querySelector('summary');
      if (opener) { opener.focus(); onOpenPetAgent(opener); }
     }}>桌宠 Agent</button>}
     <button className="chat-clear-link" type="button" disabled={!controller || session.pending || !session.turns.length} onClick={() => {
      if (options.current) options.current.open = false;
      options.current?.querySelector('summary')?.focus();
      controller?.requestClear();
     }}>清空本轮聊天…</button></div>
    </details>}
   </div>
  </header>
  <div className="chat-scrollport" ref={scrollport} role="region" aria-label="聊天消息列表" tabIndex={0} onClick={event => {
   if (event.target instanceof Element && event.target.closest('button,select,textarea,a')) return;
   if (document.activeElement === input.current) input.current?.blur();
  }}>
   {!character ? <div className="chat-empty">
    <span className="chat-empty-mark"><PetNookIcon name="chat" /></span>
    <h2>还没有可以聊天的桌宠</h2><p>在「桌宠」添加一只伙伴，再回来聊聊。</p>
    {onOpenPets && <button type="button" className="chat-control" onClick={onOpenPets}><PetNookIcon name="pets" />前往桌宠</button>}
   </div> : hasTurns ? <div className="chat-messages chat-rail">
    {session.turns.map((turn, index) => {
     const date = new Date(turn.createdAt);
     const day = date.toDateString();
     const previous = session.turns[index - 1];
     return <Fragment key={turn.id}>
      {(!previous || day !== new Date(previous.createdAt).toDateString()) && <p className="chat-day">{day === today ? '今天' : dateLabel.format(date)}</p>}
      {turn.memory ? <div className="chat-memory-exchange">
       <ChatMessage turn={turn} name={character.name} reference={reference} />
       <ChatMemoryCard proposal={turn.memory} petID={character.id} messageID={turn.id} name={character.name} controller={controller} />
      </div> : <ChatMessage turn={turn} name={character.name} reference={reference} />}
     </Fragment>;
    })}
    {session.pending && <p className="chat-waiting" role="status"><span className="status-dot" />等待回复…</p>}
   </div> : <div className="chat-welcome">
    <div className="chat-portrait" aria-hidden="true">
     <span className="chat-orbit" /><span className="chat-orbit chat-orbit-cross" />
     <PetNookIcon name="spark" className="chat-spark chat-spark-right" /><PetNookIcon name="spark" className="chat-spark chat-spark-left" />
     <span className="chat-portrait-dot" /><PetCover reference={reference} avatar />
    </div>
    <h2>今天想和{character.name}聊点什么？</h2>
    <p>{state.localAvailable ? '可以聊聊今天，也可以问问角色的本机资料。' : '从一句话开始。'}</p>
    {controller && (state.localAvailable || state.memoryAvailable) && <div className="chat-shortcuts" role="group" aria-label={state.memoryAvailable ? '本机资料快捷短句' : '本机查询快捷短句'}>
     {state.localAvailable && shortcuts.map(shortcut => <button type="button" className="chat-control" key={shortcut.text} onClick={() => fill(shortcut.text)}>
      <PetNookIcon name={shortcut.icon} />{shortcut.label}
     </button>)}
     {state.memoryAvailable && <button type="button" className="chat-control" onClick={() => fill('记住：')}><PetNookIcon name="memory" />记住一件事</button>}
    </div>}
   </div>}
  </div>
  {character && <footer className="chat-footer chat-rail">
   {session.failed && !session.pending ? <div className="chat-failure">
    <PetNookIcon name="alert" /><span role="status">{session.status || '上一条消息没有得到回复。'}</span>
    <button type="button" disabled={!controller || state.canRetry === false} onClick={() => { void controller?.retry(); }}>重试</button>
    <button type="button" disabled={!controller || !!session.draft} onClick={() => { controller?.restoreDraft(); input.current?.focus(); }}>恢复输入</button>
   </div> : <p className="chat-status" role="status">{session.status}</p>}
   <ChatComposer key={character.id} state={state} controller={controller} name={character.name} input={input} />
  </footer>}
  {session.confirmingClear && <ClearChat onCancel={() => controller?.cancelClear()} onConfirm={() => controller?.confirmClear()} />}
 </section>;
}
function ChatAvatar({ reference }: { reference?: PackageReference }) {
 return <span className="chat-avatar"><PetCover reference={reference} avatar /></span>;
}
function ChatMessage({ turn, name, reference }: { turn: ChatTurn; name: string; reference?: PackageReference }) {
 const timestamp = replyTimestamp(turn.createdAt);
 return <article className={`chat-message chat-message-${turn.role}`} data-turn-id={turn.id} aria-label={turn.role === 'assistant' ? turn.localOnly ? '本机资料回复' : '助手回复' : '你的消息'}>
  {turn.role === 'assistant' ? <><ChatAvatar reference={reference} /><div className="chat-reply">
   <div className="chat-message-meta"><strong>{name}</strong>{turn.localOnly && <span className="chat-local-label"><PetNookIcon name="lock" />本机资料</span>}
    <time dateTime={new Date(turn.createdAt).toISOString()} aria-label={`回复时间 ${timestamp}`} title={timestamp}>{timestamp.slice(0, 5)}</time>
   </div><div className="chat-bubble">{turn.text}</div>
  </div></> : <div className="chat-bubble">{turn.text}</div>}
 </article>;
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
 }} onCancel={event => { event.preventDefault(); onCancel(); }}><h2 id="chat-clear-title">清空本轮聊天？</h2><p id="chat-clear-copy">只清空本轮消息，未发送的草稿和角色资料会保留。</p><div className="button-row"><button type="button" className="button secondary" ref={cancel} onClick={onCancel}>取消</button><button type="button" className="button destructive" onClick={onConfirm}>清空聊天</button></div></dialog>;
}
