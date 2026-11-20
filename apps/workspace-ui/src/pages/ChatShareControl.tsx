import { useEffect, useId, useRef, useState } from 'react';

/** An explicit confirmation for sharing the currently displayed saved version. */
export function ChatShareControl({ enabled, locked, canGrant = true, scope, onChange }: {
  enabled: boolean; locked: boolean; canGrant?: boolean; scope: string; onChange(enabled: boolean): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const prompt = useId();
  const ask = confirming && !locked && !enabled && canGrant;
  useEffect(() => { if (!ask && confirming) setConfirming(false); }, [ask, confirming]);
  const cancel = () => { setConfirming(false); trigger.current?.focus(); };
  return <div className="module-stack" onKeyDown={event => {
    if (event.key === 'Escape' && ask) { event.preventDefault(); event.stopPropagation(); cancel(); }
  }}>
    <div className="module-step-heading">
      <span className="badge">{enabled ? '已授权在线聊天' : '仅本机'}</span>
      <button ref={trigger} type="button" className="button secondary" disabled={locked || (!enabled && !canGrant)}
        {...(!enabled ? { 'aria-expanded': ask, ...(ask ? { 'aria-controls': prompt } : {}) } : {})}
        onClick={() => enabled ? onChange(false) : setConfirming(!ask)}>{enabled ? '撤回在线授权' : '允许在线聊天使用'}</button>
    </div>
    {ask && <div id={prompt} className="module-notice" role="group" aria-label="确认在线聊天授权">
      <p>{scope}。在线发送时，相关资料可能随消息发送给所选模型的服务商。此次操作只保存授权。</p>
      <div className="button-row">
        <button type="button" className="button secondary" autoFocus onClick={cancel}>取消授权</button>
        <button type="button" className="button primary" onClick={() => { setConfirming(false); onChange(true); }}>确认授权</button>
      </div>
    </div>}
  </div>;
}
