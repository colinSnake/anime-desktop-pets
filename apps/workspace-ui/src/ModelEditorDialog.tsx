import { useEffect, useRef, useState } from 'react';
import { MODEL_API_KEY_MAX_LENGTH, normalizeModelBaseURL } from '../../../packages/contracts/src/models.ts';
import { ModelConnectionFields, ModelField, ModelReasoningField, modelName } from './ModelConnectionEditor.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import { ModelParameters } from './ModelParameters.tsx';
import { ModelDiscoveryAction, ModelDiscoveryPanel } from './ModelDiscovery.tsx';
import { keyNeedsDecision, modelProtocols, type ModelWorkspaceController, type ModelWorkspaceState } from './model-state.ts';

export type ModelEditor = { kind: 'add'; mode: 'provider' | 'custom'; provider?: string; custom?: string }
  | { kind: 'edit'; id: string };
export function ModelEditorDialog({ editor, state, controller, onMode, onClose, onSaved }: {
  editor: ModelEditor; state: ModelWorkspaceState; controller: ModelWorkspaceController;
  onMode(mode: 'provider' | 'custom'): void; onClose(): void; onSaved(): void;
}) {
  const [parameterDrafts, setParameterDrafts] = useState<ReadonlySet<string>>(new Set());
  const modelToFocus = useRef<string>(undefined);
  const keyInput = useRef<HTMLInputElement>(null);
  const [approved, setApproved] = useState<{ id: string; draft: object }>();
  useEffect(() => {
    const clear = () => { if (keyInput.current) keyInput.current.value = ''; setApproved(undefined); controller.leave(); };
    const visibility = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', clear);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', clear); };
  }, [controller]);
  const adding = editor.kind === 'add', id = (adding ? editor[editor.mode] : editor.id)!;
  const draft = state.drafts.get(id), connection = draft?.edit;
  const parametersOpen = parameterDrafts.has(id);
  const setParametersOpen = (open: boolean) => setParameterDrafts(previous => {
    const next = new Set(previous);
    if (open) next.add(id); else next.delete(id);
    return next;
  });
  const saved = state.configuration?.connections.find(item => item.id === id);
  const busy = !!state.operation || state.connectionTest?.kind === 'pending';
  const blocked = busy || state.needsRefresh || state.requiresRestart;
  const stale = controller.stale(id);
  const feedback = !state.feedback?.id || state.feedback.id === id ? state.feedback : undefined;
  const decision = draft && keyNeedsDecision(draft, saved);
  const shown = connection?.models ?? [];
  const offerTestAfterSave = controller.canTest && !!connection;
  const normalizedBase = connection && normalizeModelBaseURL(connection.baseURL, connection.apiProtocol);
  const canTestAfterSave = offerTestAfterSave && !!normalizedBase;
  const testAfterSave = canTestAfterSave && approved?.id === id && approved.draft === draft;
  const save = () => {
    const input = keyInput.current;
    void controller.save(id, input?.value ?? '', testAfterSave ? shown.map(entry => entry.entryID) : undefined, () => {
      if (input) input.value = '';
    }).then(published => {
      if (published) onSaved();
      else {
        if (shown.some(entry => !entry.modelID.trim() || /\s/u.test(entry.modelID) || !entry.displayName.trim()
          || Number.isNaN(entry.contextWindow))) setParametersOpen(true);
        setApproved(undefined); // A retry needs fresh consent to send a request.
      }
    });
  };
  const addModel = () => {
    modelToFocus.current = controller.addEntry(id);
    if (modelToFocus.current) setParametersOpen(true);
  };
  const focusModel = (entryID: string, input: HTMLInputElement | null) => {
    if (input && modelToFocus.current === entryID) {
      modelToFocus.current = undefined;
      input.focus();
    }
  };
  const testOption = offerTestAfterSave && draft && <label className="model-check model-note model-test-option"><input type="checkbox" checked={testAfterSave} disabled={blocked || stale || !canTestAfterSave}
    onChange={event => setApproved(event.currentTarget.checked ? { id, draft } : undefined)} />保存后测试连接（{shown.length > 1 ? `最多 ${shown.length} 次，每个模型一次，` : ''}可能产生费用）</label>;
  const detachKey = saved?.credentialState === 'reference-present' && draft && <label className="model-check model-note"><input type="checkbox" checked={draft.detach}
    onChange={event => controller.detachKey(id, event.currentTarget.checked)} />保存时解除旧 Key 绑定</label>;
  return <ModelDialog title={adding ? '添加配置' : '编辑配置'} subtitle={adding ? undefined : saved?.displayName} locked={busy} onClose={onClose} footer={<>{testOption}
    {state.connectionTest?.kind === 'pending' ? <button type="button" className="button secondary" onClick={() => controller.cancelConnectionTest(id, true)}>停止等待测试</button>
      : <button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button>}
    {draft && <>
      <button type="button" className="button primary" disabled={blocked || stale || !!draft.proposedProtocol} onClick={save}>保存</button>
    </>}
  </>}>
    {adding && <div className="model-modes" role="group" aria-label="添加方式">
      <button type="button" aria-pressed={editor.mode === 'provider'} disabled={busy} onClick={() => { setApproved(undefined); onMode('provider'); }}>第三方模型提供商</button>
      <button type="button" aria-pressed={editor.mode === 'custom'} disabled={busy} onClick={() => { setApproved(undefined); onMode('custom'); }}>自定义模型 API</button>
    </div>}
    {!draft && state.connectionTest?.kind === 'pending' && <p role="status" className="model-note">配置已保存，正在测试 {state.connectionTest.input.modelID}…</p>}
    {stale && <div className="model-inline" role="status"><p>{saved ? '已保存版本发生变化，请核对草稿或载入最新版本。' : '此连接已被移除或新增结果已写入，请关闭弹窗核对列表。'}</p>
      {saved && !draft?.isNew && <button type="button" className="button secondary" disabled={blocked} onClick={() => controller.reloadDraft(id)}>丢弃草稿并载入最新版本</button>}
    </div>}
    {state.needsRefresh && <button type="button" className="button secondary" disabled={busy} onClick={() => { void controller.load(); }}>重新读取</button>}
    {state.requiresRestart && <p className="model-alert" role="status">重启前只读。请先核对已保存版本。</p>}
    {draft && connection && <>
      <fieldset className="model-fieldset" disabled={blocked || stale}>
        <ModelConnectionFields draft={connection} provider={draft.provider} onEdit={(...args) => controller.patch(...args)}
          onProtocol={(...args) => controller.changeProtocol(...args)} onProvider={adding ? value => controller.selectProvider(id, value) : undefined} />
        {draft.proposedProtocol && <div className="model-inline"><p>切换至 {modelProtocols[draft.proposedProtocol]} 会清除不兼容的输出设置。</p>
          <div className="model-actions"><button type="button" className="button secondary" onClick={() => controller.cancelProtocol(id)}>保留原协议</button>
            <button type="button" className="button primary" onClick={() => controller.confirmProtocol(id)}>清除兼容项并切换</button></div></div>}
        <label className="model-field model-key">
          <span className="model-key-label"><PetNookIcon name="lock" />API Key（选填）
            {saved?.credentialState === 'reference-present' && <span className="model-key-state" aria-hidden="true">{draft.detach ? '保存时解除' : '已绑定'}</span>}
          </span>
          {!draft.detach && <input key={JSON.stringify([id, draft.expectedRevision, draft.provider, connection.baseURL, connection.apiProtocol])}
            ref={keyInput} type="password" placeholder={decision ? '输入新的 API Key' : saved?.credentialState === 'reference-present' ? '留空保留原凭证' : '所用接口不需要 Key 时可留空'}
            maxLength={MODEL_API_KEY_MAX_LENGTH} autoComplete="new-password" autoCapitalize="none" spellCheck={false}
            disabled={!!draft.proposedProtocol} onChange={() => setApproved(undefined)} />}
        </label>
        {decision && <p className="model-alert">地址或协议已变更。请输入新 Key，或解除旧绑定后无 Key 保存。</p>}
        {(decision || draft.detach) && detachKey}
        {connection.models.length > 1 && <div className="model-connection-default"><ModelField label="连接默认模型"><select value={connection.defaultModelEntryID}
          onChange={event => controller.patch(id, { defaultModelEntryID: event.currentTarget.value })}>
          {connection.models.map(entry => <option key={entry.entryID} value={entry.entryID}>{modelName(entry)}</option>)}
        </select></ModelField></div>}
        {!decision && !draft.detach && detachKey}
        <ModelParameters draftKey={`${id}:${draft.provider ?? ''}:${draft.expectedRevision}`} entries={shown} expanded={parametersOpen}
          onToggle={() => setParametersOpen(!parametersOpen)} onChange={(entryID, fields) => controller.patchEntry(id, entryID, fields)}
          canRemove={entryID => adding ? shown.length > 1 : entryID !== connection.defaultModelEntryID && !saved?.models.some(model => model.entryID === entryID)}
          onRemove={entryID => {
            // A new connection has no published route; its remaining first draft entry becomes the draft default.
            const replacement = adding ? shown.find(entry => entry.entryID !== entryID)?.entryID : undefined;
            controller.removeEntry(id, entryID, replacement);
          }} onAdd={addModel} atLimit={connection.models.length >= 33} focusModel={focusModel}
          renderOptions={entry => <ModelReasoningField connection={connection} entry={entry} controller={controller} />} />
      </fieldset>
      {!adding && saved && <details className="model-custom"><summary>已保存连接</summary><div className="model-parameter-list">
        <ModelDiscoveryAction id={id} discovery={state.discovery} controller={controller} confirmingDelete={false} />
        <ModelDiscoveryPanel id={id} discovery={state.discovery} controller={controller} models={connection.models} />
      </div></details>}
    </>}
    {feedback && <p className={feedback.error ? 'model-alert' : 'model-note'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </ModelDialog>;
}
