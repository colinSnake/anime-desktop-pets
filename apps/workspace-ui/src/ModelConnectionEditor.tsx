import { cloneElement, useId, type ReactElement } from 'react';
import type { Compatibility, ModelDraft, ModelEntry, ModelProtocol, ToolCapability } from '../../../packages/contracts/src/models.ts';
import { modelProtocols, modelProviderTemplates, type ModelProviderTemplate, type ModelWorkspaceController } from './model-state.ts';

export function ModelField({ label, children, wide }: { label: string; children: ReactElement<{ 'aria-labelledby'?: string }>; wide?: boolean }) {
  const id = useId();
  return <label className={`model-field${wide ? ' model-field-wide' : ''}`}><span id={id}>{label}</span>{cloneElement(children, { 'aria-labelledby': id })}</label>;
}
function OutputTokenField({ value, onChange, model }: { value: Compatibility; onChange(value: Compatibility): void; model?: boolean }) {
  return <ModelField label="输出 Token 字段"><select value={value.outputTokenField ?? ''} onChange={event => {
    const field = event.currentTarget.value;
    onChange(field === 'max_tokens' || field === 'max_completion_tokens' ? { outputTokenField: field } : {});
  }}><option value="">{model ? '继承连接设置' : '使用协议默认值'}</option><option>max_tokens</option><option>max_completion_tokens</option></select></ModelField>;
}
export const modelName = (entry: ModelEntry) => entry.displayName || entry.modelID || '未命名模型';

export function ModelConnectionFields({ draft, provider, onEdit, onProtocol, onProvider }: {
  draft: ModelDraft; provider?: ModelProviderTemplate; onEdit: ModelWorkspaceController['patch'];
  onProtocol: ModelWorkspaceController['changeProtocol']; onProvider?: (provider: ModelProviderTemplate) => void;
}) {
  const id = draft.id;
  return <>
    <div className="model-grid">
      {provider && onProvider ? <ModelField label="厂商"><select value={provider} onChange={event => onProvider(event.currentTarget.value as ModelProviderTemplate)}>
        {Object.entries(modelProviderTemplates).map(([value, { name }]) => <option key={value} value={value}>{name}</option>)}
      </select></ModelField> : <ModelField label="厂商"><input autoComplete="off" maxLength={128} placeholder="输入厂商名称" value={draft.displayName}
        onChange={event => onEdit(id, { displayName: event.currentTarget.value })} /></ModelField>}
      <ModelField label="接口协议"><select value={draft.apiProtocol} onChange={event => onProtocol(id, event.currentTarget.value as ModelProtocol)}>
        {Object.entries(modelProtocols).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></ModelField>
      <ModelField label="接口地址" wide><input type="url" spellCheck={false} autoComplete="off" maxLength={2048} value={draft.baseURL}
        placeholder={draft.apiProtocol === 'gemini' ? 'https://example.invalid/v1beta' : 'https://example.invalid/v1'} onChange={event => onEdit(id, { baseURL: event.currentTarget.value })} /></ModelField>
    </div>
  </>;
}

export function ModelConnectionOptions({ draft, onEdit }: { draft: ModelDraft; onEdit: ModelWorkspaceController['patch'] }) {
  const id = draft.id;
  return <div className="model-grid">
      <ModelField label="鉴权方式"><select value={draft.authMode} onChange={event => onEdit(id, { authMode: event.currentTarget.value as ModelDraft['authMode'] })}>
        <option value="apiKey">API Key</option><option value="none">无鉴权（仅本机回环）</option>
      </select></ModelField>
      {draft.apiProtocol === 'chat-completions' && <OutputTokenField value={draft.compatibility} onChange={compatibility => onEdit(id, { compatibility })} />}
  </div>;
}

const tools = { unknown: '未知', supported: '支持', unsupported: '不支持' };
const toolSources = { user: '手工', preset: '预设', discovery: '发现' };
export function ModelEntryOptions({ connection, entry, controller }: { connection: ModelDraft; entry: ModelEntry; controller: ModelWorkspaceController }) {
  const change = (fields: Partial<Omit<ModelEntry, 'entryID'>>) => controller.patchEntry(connection.id, entry.entryID, fields);
  return <div className="model-grid">
    <ModelField label={`工具能力 · ${toolSources[entry.capabilities.tools.source]}`}><select value={entry.capabilities.tools.status}
      onChange={event => change({ capabilities: { tools: { status: event.currentTarget.value as ToolCapability['status'], source: 'user' } } })}>
      {Object.entries(tools).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></ModelField>
    {connection.apiProtocol === 'chat-completions' && <OutputTokenField model value={entry.compatibility} onChange={compatibility => change({ compatibility })} />}
  </div>;
}
