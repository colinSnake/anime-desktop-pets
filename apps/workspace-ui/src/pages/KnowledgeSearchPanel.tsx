import { useEffect, useRef, useState } from 'react';
import { isKnowledgeQuery, knowledgeQueryLimit } from '../../../../packages/contracts/src/knowledge-search.ts';
import { isExpired, recordDetails } from './MemoryFields.tsx';
import { EmptyState, Field, InlineFooter, Panel } from './WorkspacePanels.tsx';
import type { KnowledgeLookup, MemorySession } from './character-record-editors.ts';

const errors = {
  invalid: '请输入有效关键词，请勿填写密码、密钥或验证码。',
  conflict: '资料已更新。请读取最新资料后重新搜索。',
  'not-found': '当前桌宠资料已不可用，请重新选择实例。',
  unavailable: '暂时无法搜索本机角色知识。',
} as const;

type SearchState = KnowledgeLookup | 'searching';

export function KnowledgeSearchPanel({ session, locked }: { session?: MemorySession; locked: boolean }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchState>();
  const [, advanceClock] = useState(0);
  const request = useRef(0);
  const disabled = locked || !session;
  const valid = isKnowledgeQuery(query);
  const matches = !disabled && result && result !== 'searching' && result.ok ? result.matches.filter(item => !isExpired(item)) : undefined;
  const nextExpiration = Math.min(...(matches ?? []).map(item => item.expiresAt ? Date.parse(item.expiresAt) : Infinity));
  useEffect(() => {
    if (!Number.isFinite(nextExpiration)) return;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      const remaining = nextExpiration - Date.now();
      if (remaining <= 0) advanceClock(time => time + 1);
      else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    }
    schedule();
    return () => clearTimeout(timer);
  }, [nextExpiration]);

  async function search() {
    if (disabled || !valid || result === 'searching') return;
    const attempt = ++request.current;
    setResult('searching');
    const found = await session.searchKnowledge(query);
    if (attempt === request.current) setResult(found);
  }

  return <Panel title="查找角色知识" description="只搜索当前桌宠已确认且仍有效的本机知识。">
    <form className="module-stack" onSubmit={event => { event.preventDefault(); void search(); }}>
      <Field label="关键词" value={query} limit={knowledgeQueryLimit} placeholder="例如：观测手册" readOnly={disabled}
        onChange={value => { request.current++; setQuery(value); setResult(undefined); }} />
      <InlineFooter hint={disabled ? '读取当前桌宠的资料后可搜索。' : '至少输入两个字符。请勿填写密码、密钥或验证码；关键词不保存。'}>
        <button className="button secondary" type="submit" disabled={disabled || !valid || result === 'searching'}>搜索角色知识</button>
      </InlineFooter>
    </form>
    {!disabled && result === 'searching' && <p className="module-copy" role="status">正在搜索本机知识…</p>}
    {!disabled && result && result !== 'searching' && !result.ok && <p className="module-copy" role="alert">{errors[result.error]}</p>}
    {matches && <div role="status">
      {matches.length ? <>
        <p className="module-copy">找到 {matches.length} 条角色知识。</p>
        {matches.map(memory => <section className="module-record" key={memory.id}>
          <p className="module-record-text">{memory.text}</p>
          <p className="module-copy">{recordDetails(memory) || '手动记录'}</p>
        </section>)}
      </> : <EmptyState title="没有找到符合条件的知识" detail="试试较短的关键词，或在待确认列表核对资料。" />}
    </div>}
  </Panel>;
}
