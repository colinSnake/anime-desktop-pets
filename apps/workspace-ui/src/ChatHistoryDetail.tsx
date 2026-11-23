import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { chatHistoryTitle, isHistoryDetailResult, type ChatHistoryDetail as Detail, type ChatHistoryDetailResult } from '../../../packages/contracts/src/chat-history.ts';
import type { PackageReference } from '../../../packages/contracts/src/pets.ts';
import { ChatMessage } from './ChatMessage.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';

const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

export function ChatHistoryDetail({ entry, name, reference, pending, notice, readPage, onBack, onContinue }: {
  entry: Detail; name: string; reference?: PackageReference; pending: boolean; notice?: string;
  readPage?: (before: string) => Promise<ChatHistoryDetailResult>;
  onBack(): void; onContinue?: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pageStatus = useRef<HTMLParagraphElement>(null);
  const reading = useRef<symbol | undefined>(undefined);
  const [older, setOlder] = useState<{ detail: Detail; cursors: string[] }>();
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState(false);
  const page = older?.detail ?? entry;
  const cursors = older?.cursors ?? [];
  useLayoutEffect(() => {
    back.current?.focus({ preventScroll: true });
    return () => { reading.current = undefined; };
  }, [entry.session.id]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = page.before === undefined ? scroll.current.scrollHeight : 0;
  }, [page]);
  async function flip(next: string[]) {
    if (reading.current || !readPage) return;
    pageStatus.current?.focus({ preventScroll: true });
    setPageError(false);
    const before = next.at(-1);
    if (before === undefined) { setOlder(undefined); return; }
    const operation = Symbol();
    reading.current = operation;
    setBusy(true);
    try {
      const result = await readPage(before);
      if (reading.current !== operation) return;
      if (isHistoryDetailResult(result, entry.session.id, before) && result.ok) setOlder({ detail: result.detail, cursors: next });
      else setPageError(true);
    } catch { if (reading.current === operation) setPageError(true); }
    finally { if (reading.current === operation) { reading.current = undefined; setBusy(false); } }
  }
  const earlier = page.hasEarlier ? page.turns[0]?.requestID : undefined;
  const pageLabel = older ? `${earlier ? '较早消息' : '最早消息'} · 第 ${cursors.length + 1} 页` : '最近消息';
  return <>
    <header className="chat-toolbar chat-reading-header">
      <div><h1>{chatHistoryTitle(entry.session)}</h1><p>{name} · 历史会话</p></div>
      <button ref={back} type="button" className="chat-control" onClick={onBack}><PetNookIcon name="chevron" />返回历史</button>
    </header>
    <div className="chat-scrollport" ref={scroll} role="region" aria-label="历史会话详情" aria-busy={busy} tabIndex={0}>
      <div className="chat-messages chat-rail">
        {page.turns.map((turn, index) => <Fragment key={turn.requestID}>
          {(index === 0 || new Date(page.turns[index - 1]!.completedAt).toDateString() !== new Date(turn.completedAt).toDateString()) &&
            <p className="chat-day"><time dateTime={new Date(turn.completedAt).toISOString()}>{date.format(turn.completedAt)}</time></p>}
          <ChatMessage turn={{ id: `${turn.requestID}-user`, role: 'user', text: turn.user, createdAt: turn.completedAt }} name={name} reference={reference} />
          <ChatMessage turn={{ id: `${turn.requestID}-assistant`, role: 'assistant', text: turn.assistant, createdAt: turn.completedAt }} name={name} reference={reference} />
        </Fragment>)}
      </div>
    </div>
    <footer className="chat-history-resume chat-rail">
      {readPage && (older || earlier) && <nav className="chat-history-detail-pages" aria-label="会话消息分页">
        <p ref={pageStatus} role="status" tabIndex={-1}>{busy ? '正在读取消息…' : pageError ? '未能读取消息，请重试。' : pageLabel}</p>
        <div className="button-row">
          <button type="button" className="chat-control" disabled={busy || !earlier} onClick={() => { if (earlier) void flip([...cursors, earlier]); }}>更早消息</button>
          <button type="button" className="chat-control" disabled={busy || !older} onClick={() => { void flip(cursors.slice(0, -1)); }}>较新消息</button>
        </div>
      </nav>}
      <p role="status">{notice ?? (pending ? '当前回复完成后即可切换。' : older ? '续聊会回到最新消息；发送时，近期可回放的普通问答会发给所选模型。' : '发送时，近期可回放的普通问答会发给所选模型。')}</p>
      <button type="button" className="button primary" disabled={pending || !onContinue} onClick={onContinue}>继续聊天</button>
    </footer>
  </>;
}
