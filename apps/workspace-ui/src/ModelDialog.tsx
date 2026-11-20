import { useEffect, useId, useRef, type ReactNode } from 'react';
import { PetNookIcon } from './PetNookIcon.tsx';

export function ModelDialog({ title, subtitle, compact = false, locked = false, onClose, children, footer }: {
  title: string; subtitle?: string; compact?: boolean; locked?: boolean; onClose(): void; children: ReactNode; footer: ReactNode;
}) {
  const titleID = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPressed = useRef(false);
  const isBackdrop = (event: { currentTarget: HTMLDialogElement; target: EventTarget; clientX: number; clientY: number }) => {
    if (event.target !== event.currentTarget) return false;
    const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
    return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
  };
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
    onPointerDown={event => { backdropPressed.current = !locked && event.isPrimary && event.button === 0 && isBackdrop(event); }}
    onPointerCancel={() => { backdropPressed.current = false; }}
    onPointerUp={event => { backdropPressed.current &&= !locked && isBackdrop(event); }}
    onClick={event => {
      const pressed = backdropPressed.current;
      backdropPressed.current = false;
      if (!locked && pressed && event.detail > 0 && isBackdrop(event)) onClose();
    }}
    onCancel={event => {
      event.preventDefault();
      if (!locked) onClose();
    }}>
    <div className="model-dialog-layout">
      <header className="model-dialog-header"><span className="model-tile" aria-hidden="true"><PetNookIcon name="models" /></span>
        <div><h2 id={titleID}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="model-icon model-dialog-close" aria-label="关闭弹窗" disabled={locked} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="model-dialog-scroll">{children}</div>
      <footer className="model-dialog-footer model-actions">{footer}</footer>
    </div>
  </dialog>;
}
