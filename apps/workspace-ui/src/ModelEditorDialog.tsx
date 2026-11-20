import { useRef, useState } from 'react';
import { isModelLoopback, normalizeModelBaseURL } from '../../../packages/contracts/src/models.ts';
import { ModelConnectionFields, ModelConnectionOptions, ModelEntryOptions, ModelField, modelName } from './ModelConnectionEditor.tsx';
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
  const [confirmClear, setConfirmClear] = useState(false);
  const modelToFocus = useRef<string>(undefined);
  const [approved, setApproved] = useState<{ id: string; draft: object }>();
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
  const stale = controller.stale(id), awaitingKey = state.operation?.kind === 'key' && state.operation.id === id;
  const feedback = !state.feedback?.id || state.feedback.id === id ? state.feedback : undefined;
  const decision = draft && keyNeedsDecision(draft, saved);
  const shown = connection?.models ?? [];
  const global = state.configuration?.defaultConnectionID === id;
  const defaultUnsaved = !!saved && connection?.defaultModelEntryID !== saved.defaultModelEntryID;
  const oldKeyRetained = saved?.credentialState === 'reference-present' && !decision && !draft?.detach;
  const offerTestAfterSave = controller.canTest && !!connection && (connection.authMode === 'none' || !draft?.detach);
  const normalizedBase = connection && normalizeModelBaseURL(connection.baseURL, connection.apiProtocol);
  const canTestAfterSave = offerTestAfterSave && !!normalizedBase && (connection.authMode === 'apiKey' || isModelLoopback(new URL(normalizedBase)));
  const testAfterSave = canTestAfterSave && approved?.id === id && approved.draft === draft;
  const save = (clipboard: boolean) => {
    void controller.save(id, clipboard, testAfterSave ? shown.map(entry => entry.entryID) : undefined).then(published => {
      if (published) onSaved();
      else {
        if (shown.some(entry => !entry.modelID.trim() || !entry.displayName.trim()
          || Number.isNaN(entry.contextWindow) || Number.isNaN(entry.maxOutputTokens))) setParametersOpen(true);
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
    {awaitingKey ? <button type="button" className="button secondary" onClick={() => controller.leave()}>取消等待</button>
      : state.connectionTest?.kind === 'pending' ? <button type="button" className="button secondary" onClick={() => controller.cancelConnectionTest(id, true)}>停止等待测试</button>
      : <button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button>}
    {draft && <>
      <button type="button" className="button primary" disabled={blocked || stale || !!draft.proposedProtocol || (!!decision && !draft.detach)
        || (testAfterSave && connection?.authMode === 'apiKey' && !oldKeyRetained)} onClick={() => save(false)}>保存</button>
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
        {connection.authMode === 'apiKey' && <section className="model-key" aria-label="API Key"><PetNookIcon name="lock" /><strong>API Key</strong>
          <span className="model-key-state">{draft.detach ? '保存时解除' : saved?.credentialState === 'reference-present' ? '已绑定' : '缺少 Key'}</span>
          {!draft.detach && <button type="button" className="model-text-button" disabled={blocked || stale || !!draft.proposedProtocol}
            title="需在 macOS「模型」菜单确认" onClick={() => save(true)}>从剪贴板保存</button>}
        </section>}
        {decision && <p className="model-alert">地址、协议或鉴权已变更。请更换 Key，或明确解除旧绑定。</p>}
        {(decision || draft.detach) && detachKey}
        <ModelParameters draftKey={`${id}:${draft.provider ?? ''}:${draft.expectedRevision}`} entries={shown} expanded={parametersOpen}
          onToggle={() => setParametersOpen(!parametersOpen)} onChange={(entryID, fields) => controller.patchEntry(id, entryID, fields)}
          canRemove={entryID => adding ? shown.length > 1 : entryID !== connection.defaultModelEntryID && !saved?.models.some(model => model.entryID === entryID)}
          onRemove={entryID => {
            // A new connection has no published route; its remaining first draft entry becomes the draft default.
            const replacement = adding ? shown.find(entry => entry.entryID !== entryID)?.entryID : undefined;
            controller.removeEntry(id, entryID, replacement);
          }} onAdd={addModel} atLimit={connection.models.length >= 33} focusModel={focusModel} />
        <details className="model-custom"><summary>连接选项与高级设置</summary><div className="model-parameter-list">
          <div className="model-parameter-group" role="group" aria-label="连接设置">
            <div className="model-parameter-heading"><strong>连接设置</strong></div>
            {!adding && shown.length > 1 && <p className="model-note">接口地址和凭证由此连接的 {shown.length} 个模型共用。</p>}
            <ModelConnectionOptions draft={connection} onEdit={(...args) => controller.patch(...args)} />
            {connection.models.length > 1 && <div className="model-connection-default"><ModelField label="连接默认模型"><select value={connection.defaultModelEntryID}
              onChange={event => controller.patch(id, { defaultModelEntryID: event.currentTarget.value })}>
              {connection.models.map(entry => <option key={entry.entryID} value={entry.entryID}>{modelName(entry)}</option>)}
            </select></ModelField></div>}
            {saved && <div className="model-default-options">
              {confirmClear && global ? <div className="model-inline"><p>清空全局默认后不会自动换用其他模型。</p><div className="model-actions">
                <button type="button" className="button secondary" onClick={() => setConfirmClear(false)}>取消清空</button>
                <button type="button" className="button destructive" disabled={blocked || stale} onClick={() => {
                  if (controller.getSnapshot().configuration?.defaultConnectionID === id) void controller.setDefault(null);
                  setConfirmClear(false);
                }}>确认清空</button></div></div> : <button type="button" className="model-text-button" disabled={blocked || stale || (!global && defaultUnsaved)}
                onClick={() => { if (global) setConfirmClear(true); else void controller.setDefault(id); }}>{global ? '清空全局默认' : '将已保存的连接默认设为全局默认'}</button>}
              {!global && defaultUnsaved && <p className="model-note">请先保存连接默认模型的变更。</p>}
            </div>}
            {!decision && !draft.detach && detachKey}
          </div>
          {shown.map((entry, index) => <div key={entry.entryID} className="model-parameter-group" role="group" aria-label={`模型 ${index + 1} 的设置`}>
            <div className="model-parameter-heading"><strong>{shown.length > 1 ? modelName(entry) : '模型设置'}</strong></div>
            <ModelEntryOptions connection={connection} entry={entry} controller={controller} />
          </div>)}
        </div></details>
      </fieldset>
      {!adding && saved && <details className="model-custom"><summary>已保存连接</summary><div className="model-parameter-list">
        <ModelDiscoveryAction id={id} discovery={state.discovery} controller={controller} confirmingDelete={false} />
        <ModelDiscoveryPanel id={id} discovery={state.discovery} controller={controller} models={connection.models} />
      </div></details>}
    </>}
    {awaitingKey && <p className="model-note" role="status">请在 macOS 菜单栏选择「模型 → 保存剪贴板中的 API Key」，核对目标地址。等待确认超过 45 秒会取消。</p>}
    {feedback && <p className={feedback.error ? 'model-alert' : 'model-note'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </ModelDialog>;
}
