import { useState } from 'react';
import type { SavedModelConnection } from '../../../packages/contracts/src/models.ts';
import { ModelField, modelName } from './ModelConnectionEditor.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import type { ModelWorkspaceController, ModelWorkspaceState } from './model-state.ts';

type ConnectionActionProps = { connection: SavedModelConnection; controller: ModelWorkspaceController; state: ModelWorkspaceState; close(): void };
const initialTarget = (connection: SavedModelConnection) => connection.models.length === 1 ? connection.models[0]!.entryID : '';
const revisionChanged = (connection: SavedModelConnection, state: ModelWorkspaceState) =>
  state.configuration?.connections.find(item => item.id === connection.id)?.revision !== connection.revision;

function ModelTarget({ label, connection, target, disabled, onChange }: {
  label: string; connection: SavedModelConnection; target: string; disabled: boolean; onChange(id: string): void;
}) {
  return <ModelField label={label}><select value={target} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>
    <option value="" disabled>请选择已保存的模型</option>
    {connection.models.map(model => <option key={model.entryID} value={model.entryID}>{modelName(model)} · {model.modelID}</option>)}
  </select></ModelField>;
}

export function DeleteModelDialog({ connection, controller, state, close }: ConnectionActionProps) {
  const [target, selectTarget] = useState(() => initialTarget(connection));
  const [replacement, setReplacement] = useState('');
  const entry = connection.models.find(item => item.entryID === target);
  const last = connection.models.length === 1;
  const needsReplacement = !last && !!entry && connection.defaultModelEntryID === entry.entryID;
  const alternatives = connection.models.filter(item => item.entryID !== target);
  const changed = revisionChanged(connection, state);
  const busy = !!state.operation;
  const hasDraft = state.drafts.has(connection.id);
  const validReplacement = alternatives.some(item => item.entryID === replacement);
  const disabled = !entry || busy || changed || hasDraft || state.needsRefresh || state.requiresRestart || (needsReplacement && !validReplacement);
  return <ModelDialog title="删除模型配置" subtitle={connection.displayName} compact locked={busy} onClose={close} footer={<>
    <button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button>
    <button type="button" className="button destructive" disabled={disabled} onClick={() => {
      if (disabled) return;
      void controller.deleteModel(connection.id, connection.revision, target,
        needsReplacement ? replacement : undefined).then(removed => { if (removed) close(); });
    }}>{busy ? '删除中…' : '确认删除'}</button>
  </>}>
    <ModelTarget label="删除模型" connection={connection} target={target} disabled={busy || changed} onChange={id => { selectTarget(id); setReplacement(''); }} />
    <p className="model-note">{!entry ? '请先选择要删除的模型。' : last ? '这是此连接的最后一个模型，删除后会一并移除连接。' : '仅删除这个模型；同连接的其他模型与凭证会保留。'}</p>
    {needsReplacement && <ModelField label="替代的连接默认模型"><select value={replacement} disabled={busy || changed} onChange={event => setReplacement(event.currentTarget.value)}>
      <option value="">请选择</option>
      {alternatives.map(item => <option key={item.entryID} value={item.entryID}>{modelName(item)}</option>)}
    </select></ModelField>}
    {changed && <p className="model-alert" role="alert">已保存版本发生变化，请关闭弹窗后重新选择模型。</p>}
    {hasDraft && <p className="model-alert">请先保存或取消此连接的草稿。</p>}
    {state.needsRefresh && <button type="button" className="button secondary" disabled={busy} onClick={() => { void controller.load(); }}>重新读取</button>}
    {state.feedback?.error && (!state.feedback.id || state.feedback.id === connection.id) && <p className="model-alert" role="alert">{state.feedback.text}</p>}
  </ModelDialog>;
}
