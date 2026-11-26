import { useId } from 'react';
import type { ChatContextUsage as Usage } from './chat-session.ts';

const compactTokens = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const tokenLabel = (count: number) => compactTokens.format(count).toLowerCase();

export function ChatContextUsage({ usage, onFocus }: { usage?: Usage; onFocus(): void }) {
 const id = useId();
 if (!usage) return <span className="chat-composer-ring" aria-hidden="true" />;
 const { inputTokens, contextWindow } = usage;
 const ratio = contextWindow !== undefined && inputTokens !== undefined ? inputTokens / contextWindow : undefined;
 const percent = contextWindow !== undefined && inputTokens !== undefined ? Math.floor(inputTokens * 100 / contextWindow) : undefined;
 return <>
  <span className="chat-composer-ring chat-usage-trigger" role="img" tabIndex={0} aria-label="上下文用量" aria-describedby={id} onFocus={onFocus}>
   <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <circle cx="7" cy="7" r="5.5" />
    {ratio !== undefined && ratio > 0 && <circle className="chat-usage-progress" cx="7" cy="7" r="5.5" pathLength="100" transform="rotate(-90 7 7)" strokeDasharray={`${Math.min(ratio, 1) * 100} 100`} />}
   </svg>
  </span>
  <div className="chat-context-usage" id={id} role="tooltip">
   <div>上下文窗口</div>
   {percent !== undefined && <div>{percent}% 已用</div>}
   <div className="chat-context-usage-detail">{inputTokens === undefined ? '暂无用量数据' : `已用 ${tokenLabel(inputTokens)} Token${contextWindow === undefined ? '' : `，共 ${tokenLabel(contextWindow)}`}`}</div>
  </div>
 </>;
}
