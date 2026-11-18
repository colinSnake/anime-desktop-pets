import { useEffect, useId, useRef } from 'react';
import { InlineFooter } from './WorkspacePanels.tsx';

export function RecordDeleteConfirmation({ kind, disabled, cancel, confirm }: {
  kind: '记忆' | '知识' | '目标'; disabled: boolean; cancel(): void; confirm(): void;
}) {
  const description = useId();
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    keep.current?.focus();
    return () => {
      if (document.activeElement === document.body && trigger instanceof HTMLButtonElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return <div className="module-notice" role="group" aria-label={`删除${kind}确认`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  }}>
    <p id={description}>{kind === '目标' ? '将从当前桌宠删除此目标和全部步骤。' : `将从当前桌宠删除此${kind}和历史版本。`} 删除后无法从这里恢复。</p>
    <InlineFooter hint="请核对此条记录。">
      <button type="button" className="button secondary" ref={keep} onClick={cancel}>保留{kind}</button>
      <button type="button" className="button destructive" aria-describedby={description} disabled={disabled} onClick={confirm}>确认删除{kind}</button>
    </InlineFooter>
  </div>;
}
