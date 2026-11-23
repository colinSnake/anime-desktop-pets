import { chatHistoryTitle, type ChatHistorySummary } from '../../../packages/contracts/src/chat-history.ts';
import { PetNookIcon } from './PetNookIcon.tsx';

const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

export function ChatHistoryList({ rows, disabled, onRead }: {
  rows: readonly ChatHistorySummary[]; disabled?: boolean;
  onRead(entry: ChatHistorySummary, trigger: HTMLButtonElement): void;
}) {
  return <ol className="chat-history-list">{rows.map(entry => <li key={entry.id}>
    <button type="button" className="chat-history-turn" disabled={disabled} onClick={event => onRead(entry, event.currentTarget)}>
      <span className="chat-history-icon"><PetNookIcon name="chat" /></span>
      <strong>{chatHistoryTitle(entry)}</strong>
      <span className="chat-history-meta">
        <time dateTime={new Date(entry.completedAt).toISOString()}>{date.format(entry.completedAt)}</time>
        <PetNookIcon name="chevron" />
      </span>
    </button>
  </li>)}</ol>;
}
