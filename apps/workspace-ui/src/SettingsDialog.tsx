import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Closing a panel changes presentation only; drafts live in the controller. */
export function SettingsDialog({ title, subtitle, returnFocusId, busy, onClose, children }: {
  title: string; subtitle?: string; returnFocusId?: string; busy: boolean; onClose(): void; children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      const opener = returnFocusId ? document.getElementById(returnFocusId) : undefined;
      if (opener instanceof HTMLButtonElement && !opener.disabled) opener.focus();
      else if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.getElementById('main')?.focus();
    };
  }, [returnFocusId]);
  return <div className="modal-backdrop settings-backdrop"><div className="pet-settings" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} ref={ref} tabIndex={-1} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    if (event.key === 'Tab') {
      const elements = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); ref.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header className="settings-heading"><div className="settings-identity"><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="button secondary compact" ref={close} disabled={busy} onClick={onClose} aria-label="关闭设置">关闭</button></header>
    {children}
  </div></div>;
}
