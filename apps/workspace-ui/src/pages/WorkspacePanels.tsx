import { useEffect, useId, useRef, type Dispatch, type ReactNode, type SetStateAction } from 'react';

export type Draft<T> = { value: T; update: Dispatch<SetStateAction<T>> };
export function patch<T>(draft: Draft<T>, value: Partial<T>) {
  draft.update(previous => ({ ...previous, ...value }));
}
export function ModulePage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <article className="workspace-module">
    <header className="module-heading"><h1>{title}</h1><p>{description}</p></header>
    {children}
  </article>;
}
export function PreviewNotice({ children }: { children: ReactNode }) {
  return <aside className="module-notice" aria-label="预览说明"><strong>仅保留在当前窗口</strong><p>{children}</p></aside>;
}
export function Panel({ title, description, focusHeading, children }: { title: string; description?: string; focusHeading?: boolean; children: ReactNode }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusHeading) heading.current?.focus(); }, [focusHeading]);
  return <section className="module-panel" aria-labelledby={id}>
    <header><h2 id={id} ref={heading} tabIndex={focusHeading ? -1 : undefined}>{title}</h2>{description && <p>{description}</p>}</header>
    {children}
  </section>;
}
export function Field({ label, value, onChange, limit, hint, placeholder, multiline = false, readOnly }: {
  label: string; value: string; onChange(value: string): void; limit: number; hint?: string; placeholder?: string; multiline?: boolean; readOnly?: boolean;
}) {
  const id = useId();
  const props = { value, maxLength: limit, placeholder, readOnly, autoComplete: 'off', 'aria-describedby': hint ? id : undefined };
  return <label className="module-field"><span>{label}</span>{multiline
    ? <textarea {...props} rows={3} onChange={event => onChange(event.currentTarget.value)} />
    : <input {...props} onChange={event => onChange(event.currentTarget.value)} />}
    {hint && <small id={id}>{hint}</small>}
  </label>;
}
export function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange(value: T): void;
}) {
  return <label className="module-field"><span>{label}</span><select value={value} onChange={event => {
    const option = options.find(item => item.value === event.currentTarget.value);
    if (option) onChange(option.value);
  }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return <details className="module-disclosure"><summary>{title}</summary><div className="module-stack">{children}</div></details>;
}
export function OptionRow({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return <div className="module-option"><div><strong>{title}</strong><p>{detail}</p></div>{children && <div className="module-actions">{children}</div>}</div>;
}
export function DisabledAction({ children, primary = false }: { children: string; primary?: boolean }) {
  return <button className={`button ${primary ? 'primary' : 'secondary'}`} type="button" disabled>{children}</button>;
}
export function InlineFooter({ hint, children }: { hint: string; children: ReactNode }) {
  return <footer className="module-footer"><p>{hint}</p><div className="module-actions">{children}</div></footer>;
}
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="module-empty"><strong>{title}</strong><p>{detail}</p></div>;
}
export function PageTabs<T extends string>({ label, selected, onSelect, items }: { label: string; selected: T; onSelect(value: T): void; items: ReadonlyArray<{ id: T; title: string; content: ReactNode }> }) {
  const id = useId(), buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return <div className="module-tabs-wrap">
    <div className="module-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}`} aria-controls={`${id}-${item.id}-panel`} aria-selected={selected === item.id} tabIndex={selected === item.id ? 0 : -1}
        ref={element => { buttons.current[index] = element; }} onClick={() => onSelect(item.id)} onKeyDown={event => {
          const count = items.length;
          const target = event.key === 'ArrowRight' ? (index + 1) % count : event.key === 'ArrowLeft' ? (index + count - 1) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : -1;
          const next = items[target];
          if (!next) return;
          event.preventDefault(); onSelect(next.id); buttons.current[target]?.focus();
        }}>{item.title}</button>)}
    </div>
    {items.map(item => <div key={item.id} role="tabpanel" tabIndex={0} id={`${id}-${item.id}-panel`} aria-labelledby={`${id}-${item.id}`} hidden={selected !== item.id}>{item.content}</div>)}
  </div>;
}
