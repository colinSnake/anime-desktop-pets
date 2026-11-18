import { useEffect, useId, useRef, useState } from 'react';

/** A disclosure, not an ARIA menu: secondary actions retain normal Tab navigation. */
export function PetCardMore({name, disabled, cloneDisabled, deleteDisabled, onClone, onDelete}: {
  name: string; disabled: boolean; cloneDisabled: boolean; deleteDisabled: boolean;
  onClone(): void; onDelete(): void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const act = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  return <div className="pet-more" ref={ref} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button className="button secondary compact" ref={trigger} disabled={disabled} aria-label={`更多${name}的操作`} aria-expanded={open && !disabled} aria-controls={id} onClick={() => setOpen(value => !value)}>更多</button>
    <div id={id} className="pet-more-actions" hidden={!open || disabled}>
      <button className="text-button" disabled={cloneDisabled} onClick={() => act(onClone)}>创建分身</button>
      <button className="text-button danger" disabled={deleteDisabled} onClick={() => act(onDelete)}>删除实例</button>
    </div>
  </div>;
}
