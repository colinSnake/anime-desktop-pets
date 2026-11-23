import { useEffect, useId, useRef, type ReactNode } from 'react';
import { DialogCloseButton, useDialogDismiss } from './DialogDismiss.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';

export function ModelDialog({ title, subtitle, compact = false, locked = false, onClose, children, footer }: {
  title: string; subtitle?: string; compact?: boolean; locked?: boolean; onClose(): void; children: ReactNode; footer: ReactNode;
}) {
  const titleID = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useDialogDismiss(onClose, locked);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement;
    const fallback = element.closest('.model-page')?.querySelector('h1');
    element.showModal();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(':disabled')) opener.focus();
      else if (fallback?.isConnected) fallback.focus();
    };
  }, []);
  return <dialog ref={dialog} className={`model-dialog${compact ? ' model-dialog-compact' : ''}`} aria-labelledby={titleID}
    {...dismiss}>
    <div className="model-dialog-layout">
      <header className="model-dialog-header"><span className="model-tile" aria-hidden="true"><PetNookIcon name="models" /></span>
        <div><h2 id={titleID}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <DialogCloseButton disabled={locked} onClose={onClose} />
      </header>
      <div className="model-dialog-scroll">{children}</div>
      <footer className="model-dialog-footer model-actions">{footer}</footer>
    </div>
  </dialog>;
}
