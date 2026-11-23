import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isHistoryClearResult, isHistoryDetailResult, isHistoryListResult, type ChatHistoryBridge, type ChatHistoryDetail, type ChatHistoryPage, type ChatHistorySummary } from '../../../packages/contracts/src/chat-history.ts';
import { ChatHistoryList } from './ChatHistoryList.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';

const unread = '暂时无法读取历史。如果仍在使用旧工作区，请先到「高级」迁移本机数据。';

// Native modal backdrops and the panel's own empty space both target the dialog.
const isBackdrop = (event: { target: EventTarget; currentTarget: HTMLDialogElement; clientX: number }) =>
  event.target === event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left;

/** Read-only history UI; activating a session is an explicit action in the chat page. */
export function ChatHistoryDialog({ petID, name, bridge, pending, opener, reading, onRead, onCleared, onClose }: {
  petID: string; name: string; bridge: ChatHistoryBridge; pending: boolean; opener?: HTMLElement;
  reading: boolean; onRead(entry: ChatHistoryDetail): void; onCleared(): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const backdropPressed = useRef(false);
  const resume = useRef<{ trigger: HTMLButtonElement; scrollTop: number }>(undefined);
  const [page, setPage] = useState<ChatHistoryPage>();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [busy, setBusy] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef<symbol | undefined>(undefined);
  useLayoutEffect(() => {
    if (reading) return;
    const panel = dialog.current!;
    panel.showModal();
    const previous = resume.current;
    resume.current = undefined;
    if (previous && scroll.current && panel.contains(previous.trigger)) {
      scroll.current.scrollTop = previous.scrollTop;
      previous.trigger.focus({ preventScroll: true });
    } else close.current?.focus({ preventScroll: true });
    return () => panel.close();
  }, [reading]);
  useLayoutEffect(() => {
    const panel = dialog.current!;
    return () => {
      queueMicrotask(() => {
        if (!panel.open && opener?.isConnected && opener.getClientRects().length && !opener.closest('[inert]')) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, [opener]);
  useEffect(() => {
    let current = true;
    const started = Promise.resolve().then(() => current ? bridge.list({ petID }) : undefined);
    void started.then(result => {
      if (!current) return;
      if (isHistoryListResult(result) && result.ok) setPage(result.page);
      else setNotice(unread);
    }).catch(() => { if (current) setNotice(unread); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; active.current = undefined; };
  }, [bridge, petID]);
  async function load(stack: Array<string | undefined>) {
    if (busy || active.current) return;
    const operation = Symbol(); active.current = operation;
    setBusy(true); setNotice('');
    try {
      const before = stack.at(-1);
      const result = await bridge.list({ petID, ...(before && { before }) });
      if (active.current !== operation) return;
      if (!isHistoryListResult(result) || !result.ok) setNotice(unread);
      else {
        setCursors(stack); setPage(result.page);
        if (scroll.current) { scroll.current.scrollTop = 0; scroll.current.focus({ preventScroll: true }); }
      }
    } catch { if (active.current === operation) setNotice(unread); }
    finally { if (active.current === operation) { active.current = undefined; setBusy(false); } }
  }
  async function read(entry: ChatHistorySummary, trigger: HTMLButtonElement) {
    if (busy || confirming || active.current) return;
    const operation = Symbol(); active.current = operation;
    setBusy(true); setNotice('');
    try {
      const result = await bridge.detail({ petID, id: entry.id });
      if (active.current !== operation) return;
      if (isHistoryDetailResult(result, entry.id) && result.ok) {
        resume.current = { trigger, scrollTop: scroll.current?.scrollTop ?? 0 };
        onRead(result.detail);
      } else setNotice('无法打开这个会话，请刷新历史后重试。');
    } catch { if (active.current === operation) setNotice('无法打开这个会话，请刷新历史后重试。'); }
    finally { if (active.current === operation) { active.current = undefined; setBusy(false); } }
  }
  async function clear() {
    if (!confirming || busy || pending || active.current) return;
    const operation = Symbol(); active.current = operation;
    setBusy(true); setNotice('');
    try {
      const result = await bridge.clear({ petID, confirmed: true });
      if (active.current !== operation) return;
      if (!isHistoryClearResult(result) || !result.ok) {
        setNotice(isHistoryClearResult(result) && !result.ok && result.error === 'busy' ? '仍有聊天在处理，请稍后再试。' : '未能确认清空结果；请先刷新历史核对。');
      } else { onCleared(); setPage({ rows: [], nextBefore: null }); setCursors([undefined]); setNotice('已清空这个桌宠的本机聊天历史。'); }
    } catch { if (active.current === operation) setNotice('未能确认清空结果；请先刷新历史核对。'); }
    finally { if (active.current === operation) { active.current = undefined; setBusy(false); setConfirming(false); } }
  }
  const dismiss = () => {
    if (active.current) return;
    if (confirming) setConfirming(false);
    else onClose();
  };
  return <dialog ref={dialog} className="workspace-drawer chat-history" aria-labelledby="chat-history-title" aria-describedby="chat-history-description"
    onPointerDown={event => { backdropPressed.current = event.isPrimary && event.button === 0 && isBackdrop(event); }}
    onPointerUp={event => { backdropPressed.current &&= isBackdrop(event); }}
    onPointerCancel={() => { backdropPressed.current = false; }}
    onClick={event => {
      const pressed = backdropPressed.current;
      backdropPressed.current = false;
      if (pressed && event.detail > 0 && isBackdrop(event)) dismiss();
    }}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className="workspace-drawer-header chat-history-header">
      <div><h2 id="chat-history-title">聊天历史</h2><p id="chat-history-description">{name} · 查看已保存的会话，或接着聊。</p></div>
      <button ref={close} className="workspace-drawer-close" type="button" aria-label="关闭聊天历史" title="关闭"
        disabled={busy && !!active.current} onClick={() => { if (!active.current) onClose(); }}><PetNookIcon name="close" /></button>
    </header>
    <div ref={scroll} className="workspace-drawer-scroll chat-history-scroll" role="region" aria-label="本机聊天历史" tabIndex={0}>
      {busy && !page ? <p role="status">正在读取历史…</p> : page?.rows.length ?
        <ChatHistoryList rows={page.rows} disabled={busy || confirming} onRead={(entry, trigger) => { void read(entry, trigger); }} /> :
        page ? <p>还没有已保存的聊天。</p> : null}
    </div>
    {notice && <p className="chat-history-notice" role="status">{notice}</p>}
    {confirming ? <footer className="chat-history-confirm">
      <p>清空这个桌宠的全部本机聊天历史？当前消息、未发送的草稿和角色资料会保留。其他会话的草稿可在聊天选项中恢复；下次发送不会带上已清空的历史。</p>
      <div className="button-row"><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
        <button type="button" className="button destructive" disabled={busy || pending} onClick={() => { void clear(); }}>确认清空</button></div>
    </footer> : <footer className="chat-history-footer">
      <div className="button-row">
        {!page || notice ? <button type="button" className="chat-control" disabled={busy} onClick={() => { void load([undefined]); }}>刷新历史</button> : null}
        {cursors.length > 1 && <button type="button" className="chat-control" disabled={busy} onClick={() => { void load(cursors.slice(0, -1)); }}>较新记录</button>}
        {page?.nextBefore && <button type="button" className="chat-control" disabled={busy} onClick={() => { void load([...cursors, page.nextBefore!]); }}>更早记录</button>}
      </div>
      {page && !!page.rows.length && <button type="button" className="chat-control chat-history-delete" disabled={busy || pending || !!notice} onClick={() => setConfirming(true)}>清空历史…</button>}
    </footer>}
  </dialog>;
}
