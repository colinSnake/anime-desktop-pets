import { useId, useState, type ReactNode } from 'react';
import type { ModelEntry } from '../../../packages/contracts/src/models.ts';
import { ModelField } from './ModelConnectionEditor.tsx';

const capacities = ['contextWindow'] as const;
const capacityText = (value?: number) => value === undefined || !Number.isFinite(value) ? ''
  : value % 1_000_000 === 0 ? `${value / 1_000_000}M` : value % 1_000 === 0 ? `${value / 1_000}K` : String(value);
function CapacityField({ label, value, placeholder, hintID, onChange }: { label: string; value?: number; placeholder: string; hintID: string; onChange(value?: number): void }) {
  const [text, setText] = useState(() => capacityText(value));
  return <ModelField label={label}><input value={text} autoComplete="off" spellCheck={false} placeholder={placeholder} maxLength={20}
    aria-describedby={hintID} aria-invalid={Number.isNaN(value) || undefined} onChange={event => {
      const next = event.currentTarget.value; setText(next);
      if (!next.trim()) { onChange(); return; }
      const match = /^(\d+)(?:\.(\d+))?([km])?$/i.exec(next.trim());
      const [, whole, fraction = '', suffix] = match ?? [];
      const scale = suffix?.toLowerCase() === 'm' ? 6 : suffix ? 3 : 0;
      const parsed = whole && fraction.length <= scale ? Number(`${whole}${fraction.padEnd(scale, '0')}`) : NaN;
      onChange(Number.isInteger(parsed) && parsed >= 1 && parsed <= 2147483647 ? parsed : NaN);
    }} /></ModelField>;
}
function ParameterFields({ entry, hintID, onChange, focusModel }: {
  entry: ModelEntry; hintID: string; onChange(fields: Partial<Omit<ModelEntry, 'entryID'>>): void;
  focusModel(node: HTMLInputElement | null): void;
}) {
  return <div className="model-grid">
    <ModelField label="模型 ID"><input ref={focusModel} value={entry.modelID} placeholder="输入模型 ID" maxLength={256}
      spellCheck={false} autoComplete="off" autoCapitalize="none" aria-required="true"
      onChange={event => onChange({ modelID: event.currentTarget.value })} /></ModelField>
    <ModelField label="配置名称"><input value={entry.displayName} placeholder="为模型起个名字" maxLength={128}
      autoComplete="off" aria-required="true" onChange={event => onChange({ displayName: event.currentTarget.value })} /></ModelField>
    {capacities.map(field => <CapacityField key={field} label="上下文窗口"
      value={entry[field]} placeholder="如 128K" hintID={hintID} onChange={value => onChange({ [field]: value })} />)}
  </div>;
}

export function ModelParameters({ entries, draftKey, expanded, onToggle, onChange, canRemove, onRemove, onAdd, atLimit, focusModel, renderOptions }: {
  entries: readonly ModelEntry[]; draftKey: string; expanded: boolean; onToggle(): void;
  onChange(id: string, fields: Partial<Omit<ModelEntry, 'entryID'>>): void;
  canRemove(id: string): boolean; onRemove(id: string): void;
  onAdd?(): void; atLimit: boolean; focusModel(id: string, node: HTMLInputElement | null): void;
  renderOptions?(entry: ModelEntry): ReactNode;
}) {
  const parametersID = useId(), hintID = `${parametersID}-hint`;
  return <div className="model-parameters">
    <button type="button" className="model-parameter-toggle" aria-expanded={expanded} aria-controls={parametersID} onClick={onToggle}>
      <span>模型参数 <small>{entries.length} 个</small></span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div id={parametersID} className="model-parameter-list model-parameter-fields" role="group" aria-label="模型参数" hidden={!expanded}>
      {entries.map((entry, index) => <div key={`${draftKey}:${entry.entryID}`} className="model-parameter-group" role="group" aria-label={`模型 ${index + 1}`}>
        {entries.length > 1 && <div className="model-parameter-heading"><strong>模型 {index + 1}</strong>
          {canRemove(entry.entryID) && <button type="button" className="model-icon model-remove-parameter" aria-label={`移除模型 ${index + 1}`} onClick={() => onRemove(entry.entryID)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>}</div>}
        <ParameterFields entry={entry} hintID={hintID} onChange={fields => onChange(entry.entryID, fields)} focusModel={node => focusModel(entry.entryID, node)} />
        {renderOptions?.(entry)}
      </div>)}
      <small id={hintID} className="model-note">上下文容量可选，支持 K / M，留空不设置</small>
      {onAdd && <button type="button" className="model-add-parameter" disabled={atLimit} onClick={onAdd}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        再添加一个模型
      </button>}
    </div>
  </div>;
}
