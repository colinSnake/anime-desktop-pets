import { useEffect, useId, useRef, type ReactNode } from 'react';

import { DialogCloseButton, useDialogDismiss } from './DialogDismiss.tsx';

/** Closing settings changes presentation only; drafts live in the controller. */
export function SettingsDialog({ title, subtitle, returnFocusId, busy, onClose, children }: {
  title: string; subtitle?: string; returnFocusId?: string; busy: boolean; onClose(): void; children: ReactNode;
}) {
  const titleId = useId();
  const subtitleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const openerId = useRef(returnFocusId);
  const dismiss = useDialogDismiss(onClose, busy);
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
    aria-busy={busy} ref={dialog} {...dismiss}>
    <header className="settings-heading"><div className="settings-identity"><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div><DialogCloseButton label="关闭设置" disabled={busy} onClose={onClose} /></header>
    {children}
  </dialog>;
}
