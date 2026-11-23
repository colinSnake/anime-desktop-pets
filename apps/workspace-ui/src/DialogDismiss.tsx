import { useRef, type DialogHTMLAttributes, type Ref } from 'react';
import { PetNookIcon } from './PetNookIcon.tsx';

export function DialogCloseButton({ onClose, disabled, label = '关闭弹窗', ref }: {
  onClose(): void; disabled?: boolean; label?: string; ref?: Ref<HTMLButtonElement>;
}) {
  return <button type="button" className="dialog-close" aria-label={label} title="关闭" disabled={disabled} onClick={onClose} ref={ref}>
    <PetNookIcon name="close" />
  </button>;
}

function isBackdrop(event: { currentTarget: HTMLDialogElement; target: EventTarget; clientX: number; clientY: number }) {
  if (event.target !== event.currentTarget) return false;
  // Both the native backdrop and unused space inside the dialog target the dialog itself.
  const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

/** Dismiss on a complete backdrop click, never on a drag into or out of the dialog. */
export function useDialogDismiss(onClose: () => void, locked = false, onEscape = onClose): Pick<
  DialogHTMLAttributes<HTMLDialogElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onClick' | 'onCancel'
> {
  const press = useRef<{ id: number; x: number; y: number; released: boolean } | null>(null);
  return {
    onPointerDown: event => {
      press.current = !locked && event.isPrimary && event.button === 0 && isBackdrop(event)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, released: false } : null;
    },
    onPointerMove: event => {
      const start = press.current;
      if (start?.id === event.pointerId && (!isBackdrop(event) || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)) press.current = null;
    },
    onPointerUp: event => {
      const start = press.current;
      if (!locked && start && start.id === event.pointerId && isBackdrop(event) &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) start.released = true;
      else press.current = null;
    },
    onPointerCancel: () => { press.current = null; },
    onClick: event => {
      const start = press.current;
      press.current = null;
      if (!locked && start?.released && event.detail > 0 && isBackdrop(event)) onClose();
    },
    onCancel: event => {
      event.preventDefault();
      if (!locked) onEscape();
    },
  };
}
