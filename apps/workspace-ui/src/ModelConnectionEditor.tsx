import { cloneElement, useId, type ReactElement } from 'react';
import type { ModelDraft, ModelEntry, ModelProtocol } from '../../../packages/contracts/src/models.ts';
import { modelReasoningLevels, defaultReasoningEffort, reasoningLabels } from '../../../packages/contracts/src/model-capabilities.ts';
import { modelProtocols, modelProviderTemplates, type ModelProviderTemplate, type ModelWorkspaceController } from './model-state.ts';

export function ModelField({ label, children, wide }: { label: string; children: ReactElement<{ 'aria-labelledby'?: string }>; wide?: boolean }) {
  const id = useId();
  return <label className={`model-field${wide ? ' model-field-wide' : ''}`}><span id={id}>{label}</span>{cloneElement(children, { 'aria-labelledby': id })}</label>;
}
export const modelName = (entry: ModelEntry) => entry.displayName || entry.modelID || '未命名模型';

export function ModelConnectionFields({ draft, provider, onEdit, onProtocol, onProvider }: {
  draft: ModelDraft; provider?: ModelProviderTemplate; onEdit: ModelWorkspaceController['patch'];
  onProtocol: ModelWorkspaceController['changeProtocol']; onProvider?: (provider: ModelProviderTemplate) => void;
}) {
  const id = draft.id;
  return <>
    <div className="model-grid">
      {provider && onProvider ? <ModelField label="服务商"><select value={provider} onChange={event => onProvider(event.currentTarget.value as ModelProviderTemplate)}>
        {Object.entries(modelProviderTemplates).map(([value, { name }]) => <option key={value} value={value}>{name}</option>)}
      </select></ModelField> : <ModelField label="服务商"><input autoComplete="off" maxLength={128} placeholder="输入服务商名称" value={draft.displayName}
        onChange={event => onEdit(id, { displayName: event.currentTarget.value })} /></ModelField>}
      <ModelField label="接口协议"><select value={draft.apiProtocol} onChange={event => onProtocol(id, event.currentTarget.value as ModelProtocol)}>
        {Object.entries(modelProtocols).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></ModelField>
      <ModelField label="接口地址" wide><input type="url" spellCheck={false} autoComplete="off" maxLength={2048} value={draft.baseURL}
        placeholder={draft.apiProtocol === 'gemini' ? 'https://example.invalid/v1beta' : 'https://example.invalid/v1'} onChange={event => onEdit(id, { baseURL: event.currentTarget.value })} /></ModelField>
    </div>
  </>;
}

export function ModelReasoningField({ connection, entry, controller }: { connection: ModelDraft; entry: ModelEntry; controller: ModelWorkspaceController }) {
  const reasoningLevels = modelReasoningLevels({ protocol: connection.apiProtocol, baseURL: connection.baseURL, modelID: entry.modelID });
  return <div className="model-grid">
    <ModelField label="思考深度"><select disabled={!reasoningLevels.length} value={entry.reasoningEffort ?? defaultReasoningEffort(reasoningLevels) ?? ''} onChange={event => {
      const reasoningEffort = reasoningLevels.find(effort => effort === event.currentTarget.value);
      controller.patchEntry(connection.id, entry.entryID, { reasoningEffort });
    }}>{!reasoningLevels.length && <option value="">由模型自动决定</option>}{reasoningLevels.map(effort => <option key={effort} value={effort}>{reasoningLabels[effort]}</option>)}</select></ModelField>
  </div>;
}
