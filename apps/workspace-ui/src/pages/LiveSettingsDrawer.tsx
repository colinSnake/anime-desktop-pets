import { useEffect, useId, useRef, type ReactNode } from 'react';
import { DialogCloseButton, useDialogDismiss } from '../DialogDismiss.tsx';

/** Presentation only: callers keep their drafts and operation gates outside the dialog. */
export function LiveSettingsDrawer({ title, subtitle, busy = false, onClose, children, footer }: {
  title: string; subtitle?: string; busy?: boolean; onClose(): void; children: ReactNode; footer?: ReactNode;
}) {
  const titleID = useId();
  const subtitleID = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useDialogDismiss(onClose, busy);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(':disabled')) opener.focus({ preventScroll: true });
      else document.getElementById('main')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog className="live-settings-drawer" ref={dialog} aria-modal="true" aria-busy={busy}
    aria-labelledby={titleID} aria-describedby={subtitle ? subtitleID : undefined} {...dismiss}>
    <div className="live-settings-inner">
      <header className="live-settings-heading"><div>{subtitle && <p id={subtitleID}>{subtitle}</p>}<h2 id={titleID}>{title}</h2></div>
        <DialogCloseButton label="关闭设置" disabled={busy} onClose={onClose} />
      </header>
      <div className="live-settings-body">{children}</div>
      {footer && <footer className="live-settings-footer">{footer}</footer>}
    </div>
  </dialog>;
}
