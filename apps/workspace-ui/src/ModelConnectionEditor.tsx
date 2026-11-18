import { useId, useState, type ReactNode } from 'react';
import type { Compatibility, ModelDraft, ModelEntry, ModelProtocol, ToolCapability } from '../../../packages/contracts/src/models.ts';
import { modelPresets, modelProtocols, type ModelWorkspaceController } from './model-state.ts';

export function ModelField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="model-field"><span>{label}</span>{children}</label>;
}
function OutputTokenField({ value, onChange, model = false }: { value: Compatibility; onChange(value: Compatibility): void; model?: boolean }) {
  return <ModelField label="输出预算字段"><select value={value.outputTokenField ?? ''} onChange={event => {
    const selected = event.currentTarget.value;
    onChange(selected === 'max_tokens' || selected === 'max_completion_tokens' ? { outputTokenField: selected } : {});
  }}><option value="">{model ? '继承连接设置' : '使用协议默认值'}</option><option>max_tokens</option><option>max_completion_tokens</option></select></ModelField>;
}
export const modelName = (entry: ModelEntry) => entry.displayName || entry.modelID || '未命名模型';

export function ModelConnectionFields({ draft, onEdit, onProtocol }: { draft: ModelDraft; onEdit: ModelWorkspaceController['patch']; onProtocol: (id: string, protocol: ModelProtocol) => void }) {
  const id = draft.id;
  return <>
    <div className="model-grid">
      <ModelField label="厂商预设"><select value={draft.preset} onChange={event => onEdit(id, { preset: event.currentTarget.value as ModelDraft['preset'] })}>
        {Object.entries(modelPresets).map(([value, { name }]) => <option key={value} value={value}>{name}</option>)}
      </select></ModelField>
      <ModelField label="连接名称"><input autoComplete="off" maxLength={128} value={draft.displayName} onChange={event => onEdit(id, { displayName: event.currentTarget.value })} /></ModelField>
      <ModelField label="协议"><select value={draft.apiProtocol} onChange={event => onProtocol(id, event.currentTarget.value as ModelProtocol)}>
        {Object.entries(modelProtocols).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></ModelField>
      <ModelField label="鉴权方式"><select value={draft.authMode} onChange={event => onEdit(id, { authMode: event.currentTarget.value as ModelDraft['authMode'] })}>
        <option value="apiKey">API Key</option><option value="none">无鉴权（仅本机回环）</option>
      </select></ModelField>
    </div>
    <details className="model-custom" open={draft.preset === 'custom' || undefined}>
      <summary>自定义设置</summary>
      <div className="model-grid">
        <ModelField label="接入根地址"><input type="url" spellCheck={false} autoComplete="off" maxLength={2048} value={draft.baseURL}
          placeholder={draft.apiProtocol === 'gemini' ? 'https://example.invalid/v1beta' : 'https://example.invalid/v1'} onChange={event => onEdit(id, { baseURL: event.currentTarget.value })} /></ModelField>
        {draft.apiProtocol === 'chat-completions' && <OutputTokenField value={draft.compatibility} onChange={compatibility => onEdit(id, { compatibility })} />}
      </div>
      <p className="model-note">填协议根地址，保留服务部署前缀。不要填完整生成路径、Key、查询参数或片段；远端只接受 HTTPS。{draft.apiProtocol === 'gemini' ? ' Gemini 地址须以 /v1 或 /v1beta 结尾。' : ''}</p>
    </details>
  </>;
}

export function ModelEntryCard({ connection, entry, expanded, editable, blocked, controller }: {
  connection: ModelDraft; entry: ModelEntry; expanded: boolean; editable: boolean; blocked: boolean; controller: ModelWorkspaceController;
}) {
  const [removing, setRemoving] = useState(false);
  const [replacement, setReplacement] = useState('');
  const id = connection.id, defaultEntry = connection.defaultModelEntryID === entry.entryID;
  const region = useId();
  const change = (fields: Partial<Omit<ModelEntry, 'entryID'>>) => controller.patchEntry(id, entry.entryID, fields);
  const rest = connection.models.filter(model => model.entryID !== entry.entryID);
  const tools = { unknown: '未知', supported: '支持', unsupported: '不支持' };
  const sources = { user: '手工', preset: '预设', discovery: '发现' };
  const parseCapacity = (value: string) => value === '' ? undefined : Number(value);
  return <article className="model-entry">
    <button type="button" className="model-disclosure" aria-expanded={expanded} aria-controls={region} onClick={() => controller.toggleModel(id, entry.entryID)}>
      <span className="model-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span><span><strong>{modelName(entry)}</strong>{entry.modelID && <code>{entry.modelID}</code>}</span>
      {defaultEntry && <span className="model-chip">连接默认</span>}
    </button>
    <div id={region} className="model-entry-body" hidden={!expanded}>
      {expanded && (editable ? <fieldset disabled={blocked} className="model-fieldset">
        <div className="model-grid">
          <ModelField label="模型 API ID"><input value={entry.modelID} maxLength={256} spellCheck={false} autoComplete="off" onChange={event => change({ modelID: event.currentTarget.value })} /></ModelField>
          <ModelField label="显示名称"><input value={entry.displayName} maxLength={128} autoComplete="off" onChange={event => change({ displayName: event.currentTarget.value })} /></ModelField>
          <ModelField label="上下文容量（可选）"><input type="number" value={entry.contextWindow ?? ''} min={1} max={2147483647} step={1} onChange={event => change({ contextWindow: parseCapacity(event.currentTarget.value) })} /></ModelField>
          <ModelField label="最大输出 Token（可选）"><input type="number" value={entry.maxOutputTokens ?? ''} min={1} max={2147483647} step={1} onChange={event => change({ maxOutputTokens: parseCapacity(event.currentTarget.value) })} /></ModelField>
          <ModelField label={`工具能力 · ${sources[entry.capabilities.tools.source]}`}><select value={entry.capabilities.tools.status} onChange={event => change({ capabilities: { tools: { status: event.currentTarget.value as ToolCapability['status'], source: 'user' } } })}>
            {Object.entries(tools).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></ModelField>
          {connection.apiProtocol === 'chat-completions' && <OutputTokenField model value={entry.compatibility} onChange={compatibility => change({ compatibility })} />}
        </div>
        {!removing && <div className="model-actions"><button type="button" className="button secondary" disabled={!rest.length} onClick={() => { setReplacement(''); setRemoving(true); }}>移除模型</button></div>}
        {removing && <div className="model-inline">
          {defaultEntry && <ModelField label="替代的连接默认模型"><select value={replacement} onChange={event => setReplacement(event.currentTarget.value)}><option value="">请选择</option>{rest.map(model => <option key={model.entryID} value={model.entryID}>{modelName(model)}</option>)}</select></ModelField>}
          <div className="model-actions"><button type="button" className="button secondary" onClick={() => setRemoving(false)}>保留模型</button>
            <button type="button" className="button destructive" disabled={defaultEntry && !rest.some(model => model.entryID === replacement)} onClick={() => { controller.removeEntry(id, entry.entryID, defaultEntry ? replacement : undefined); setRemoving(false); }}>从草稿移除</button></div>
        </div>}
      </fieldset> : <div className="model-actions"><span className="model-note">工具：{tools[entry.capabilities.tools.status]} · {sources[entry.capabilities.tools.source]}{entry.contextWindow ? ` · 上下文 ${entry.contextWindow}` : ''}{entry.maxOutputTokens ? ` · 输出 ${entry.maxOutputTokens}` : ''}</span>
        <button type="button" className="button secondary" disabled={blocked} onClick={() => { void controller.setDefault(id, entry.entryID); }}>设为全局默认模型</button></div>)}
    </div>
  </article>;
}
