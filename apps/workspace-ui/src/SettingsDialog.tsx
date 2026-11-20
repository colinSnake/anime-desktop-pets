import { useEffect, useId, useRef, type ReactNode } from 'react';

function onBackdrop(event: { currentTarget: HTMLDialogElement; target: EventTarget; clientX: number; clientY: number }) {
  if (event.target !== event.currentTarget) return false;
  const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

/** Closing settings changes presentation only; drafts live in the controller. */
export function SettingsDialog({ title, subtitle, returnFocusId, busy, onClose, children }: {
  title: string; subtitle?: string; returnFocusId?: string; busy: boolean; onClose(): void; children: ReactNode;
}) {
  const titleId = useId();
  const subtitleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const openerId = useRef(returnFocusId);
  const backdropPointer = useRef<number | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    const opener = (openerId.current && document.getElementById(openerId.current)) || document.activeElement;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(':disabled')) opener.focus({preventScroll:true});
      else document.getElementById('main')?.focus({preventScroll:true});
    };
  }, []);
  return <dialog className="pet-settings" aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined}
    aria-busy={busy} ref={dialog}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onPointerDown={event => {
      backdropPointer.current = !busy && event.isPrimary && event.button === 0 && onBackdrop(event) ? event.pointerId : null;
    }}
    onPointerCancel={() => { backdropPointer.current = null; }}
    onPointerUp={event => {
      if (busy || backdropPointer.current !== event.pointerId || !onBackdrop(event)) backdropPointer.current = null;
    }}
    onClick={event => {
      const pressedOnBackdrop = backdropPointer.current !== null;
      backdropPointer.current = null;
      if (!busy && pressedOnBackdrop && event.detail > 0 && onBackdrop(event)) onClose();
    }}>
    <header className="settings-heading"><div className="settings-identity"><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div><button type="button" className="button secondary compact" disabled={busy} onClick={onClose} aria-label="关闭设置">关闭</button></header>
    {children}
  </dialog>;
}
