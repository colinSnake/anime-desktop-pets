import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { SavedModelConnection } from '../../../packages/contracts/src/models.ts';
import { DeleteModelDialog } from './ModelConnectionActions.tsx';
import { probeResultText } from './ModelConnectionTest.tsx';
import { ModelEditorDialog, type ModelEditor } from './ModelEditorDialog.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import { emptyModelState, probeResultKey, type ModelWorkspaceController, type ModelWorkspaceState } from './model-state.ts';

const noop = () => () => {};
const empty = () => emptyModelState;
type Action = ModelEditor | { kind: 'delete'; connection: SavedModelConnection };

function ConnectionStatus({ connection, state, controller }: {
  connection: SavedModelConnection; state: ModelWorkspaceState; controller: ModelWorkspaceController;
}) {
  const { id, revision, displayName, defaultModelEntryID } = connection;
  const active = state.connectionTest;
  const testing = active?.kind === 'pending' && active.input.connectionID === id &&
    active.input.expectedRevision === revision && active.input.entryID === defaultModelEntryID;
  const previous = state.probeResults?.get(probeResultKey(id, defaultModelEntryID));
  const result = previous?.input.expectedRevision === revision ? previous : undefined;
  const status = !result || (!result.result.ok && result.result.error === 'cancelled') ? 'untested' : result.result.ok ? 'ok' : 'failed';
  const label = testing ? '测试中' : status === 'ok' ? '测试成功' : status === 'failed' ? '测试失败' : '未测试';
  const detail = !testing && result ? probeResultText(result) : undefined;
  const reason = controller.savedDefaultTestBlockedReason(id, revision);
  const action = status === 'failed' ? '点击重新测试连接，可能产生费用。' : '点击发送一次短测试，可能产生费用。';
  const title = [label, detail, testing ? undefined : reason ?? action].filter(Boolean).join(' · ');
  return <>
    <button type="button" className="model-status-button" data-status={status} data-testing={testing || undefined}
      aria-disabled={reason ? true : undefined} aria-label={`测试连接 ${displayName}：${label}${!testing && reason ? `。${reason}` : ''}`}
      title={title} onClick={() => { if (!reason) void controller.testSavedDefault(id, revision); }}>
      <span className="model-status-dot" aria-hidden="true" />
    </button>
    <span className="sr-only" role="status">{testing || result ? `${displayName}：${detail ?? label}` : ''}</span>
  </>;
}

function ConnectionRow({ connection, state, controller, blocked, onEdit, onDelete }: {
  connection: SavedModelConnection; state: ModelWorkspaceState; controller: ModelWorkspaceController; blocked: boolean; onEdit(): void; onDelete(): void;
}) {
  const name = connection.displayName;
  return <li className="model-row">
    <div className="model-identity">
      <span className="model-tile" data-preset={connection.preset}><PetNookIcon name={connection.preset === 'custom' ? 'globe' : 'models'} /></span>
      <div className="model-service-name"><strong>{name}</strong><ConnectionStatus connection={connection} state={state} controller={controller} /></div>
    </div>
    <div className="model-row-actions">
      <button type="button" className="button secondary" disabled={blocked} aria-label={`编辑 ${name}`} onClick={event => { event.currentTarget.focus(); onEdit(); }}>编辑</button>
      <button type="button" className="button secondary model-delete" disabled={blocked} aria-label={`删除 ${name}`} onClick={event => { event.currentTarget.focus(); onDelete(); }}>删除</button>
    </div>
  </li>;
}

export function ModelPage({ controller, appearance }: { controller?: ModelWorkspaceController; appearance?: ReactNode }) {
  const state = useSyncExternalStore(controller?.subscribe ?? noop, controller?.getSnapshot ?? empty, controller?.getSnapshot ?? empty);
  useEffect(() => { controller?.open(); return () => controller?.leave(); }, [controller]);
  const [action, setAction] = useState<Action>();
  const busy = !!state.operation || state.connectionTest?.kind === 'pending';
  const blocked = busy || state.needsRefresh || state.requiresRestart;
  const config = state.configuration, rows = config?.connections ?? [];
  const close = () => setAction(undefined);
  const chooseDraft = (mode: 'provider' | 'custom', alternativeDraftID?: string) => {
    if (!controller) return;
    const existing = [...controller.getSnapshot().drafts.values()].find(draft => draft.isNew && Boolean(draft.provider) === (mode === 'provider'));
    if (existing) return existing.edit.id;
    const id = controller.add(mode === 'provider' ? 'deepseek' : 'custom', alternativeDraftID);
    if (id && mode === 'provider') controller.selectProvider(id, 'deepseek');
    if (id && mode === 'custom') controller.patch(id, { displayName: '' });
    return id;
  };
  const add = () => {
    const draftIDs = [...state.drafts.values()].filter(draft => draft.isNew);
    const mode = draftIDs.length && !draftIDs.some(draft => draft.provider) ? 'custom' : 'provider';
    const id = chooseDraft(mode);
    if (id) setAction({ kind: 'add', mode, [mode]: id });
  };
  const closeEditor = (editor: ModelEditor) => {
    if (editor.kind === 'add') {
      for (const [id, draft] of controller?.getSnapshot().drafts ?? []) if (draft.isNew) controller?.cancel(id);
    } else controller?.cancel(editor.id);
    close();
  };
  const addButton = <button type="button" className="button primary model-add-config" disabled={blocked || !config || config.connections.length >= 32}
    onClick={event => { event.currentTarget.focus(); add(); }}><PetNookIcon name="plus" />添加配置</button>;
  return <article className="model-page">
    <header className="model-page-header"><div><p className="model-page-crumb" aria-hidden="true">工作区 › 设置</p><h1 tabIndex={-1}>模型管理</h1></div><div className="model-actions">
      {appearance}{controller?.available && (rows.length > 0 || !config) && addButton}
    </div></header>
    {!controller?.available ? <p className="model-empty">本机模型管理当前不可用。</p> : <section aria-label="已配置的服务商" className="model-models">
      <div className="model-list-header"><h2>已配置的服务商</h2><button type="button" className="model-icon" aria-label="重新读取服务商列表" title="重新读取服务商列表"
        disabled={busy} onClick={() => { void controller.load(); }}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 0 0-14-5L3 9m0-5v5h5m-4 4a8 8 0 0 0 14 5l3-3m0 5v-5h-5" /></svg></button></div>
      {state.feedback && !action && <p className={state.feedback.error ? 'model-alert' : 'model-note'} role={state.feedback.error ? 'alert' : 'status'}>{state.feedback.text}</p>}
      {state.requiresRestart && <p className="model-alert" role="status">重启前只读。请重新读取，核对磁盘版本。</p>}
      {!config && !state.feedback && <p className="model-empty" role="status">正在读取服务商配置…</p>}
      {config && (rows.length === 0 ? <div className="model-empty-state">
        <div className="model-empty-art" aria-hidden="true">
          <span className="model-empty-tile"><PetNookIcon name="models" /></span>
          <PetNookIcon name="spark" className="model-empty-spark model-empty-spark-upper" />
          <PetNookIcon name="spark" className="model-empty-spark model-empty-spark-lower" />
        </div>
        <div><h3>尚未添加服务商配置</h3><p>选择第三方模型提供商或自定义模型 API，配置完成后即可在聊天中选用。</p></div>
        {addButton}
      </div> : <ul className="model-list" aria-label="服务商列表">{rows.map(connection =>
        <ConnectionRow key={connection.id} connection={connection} state={state} controller={controller} blocked={blocked}
          onEdit={() => { controller.edit(connection.id); setAction({ kind: 'edit', id: connection.id }); }}
          onDelete={() => setAction({ kind: 'delete', connection })} />)}</ul>)}
      {config?.connections.length === 32 && <p className="model-note">已达连接上限。仍可在编辑中为现有连接添加模型。</p>}
    </section>}
    {controller && action && (action.kind === 'add' || action.kind === 'edit') && <ModelEditorDialog editor={action} state={state} controller={controller}
      onMode={mode => {
        if (action.kind !== 'add' || action.mode === mode) return;
        const id = action[mode] ?? chooseDraft(mode, action[action.mode]);
        if (id) setAction({ ...action, [mode]: id, mode });
      }} onClose={() => closeEditor(action)} onSaved={() => closeEditor(action)} />}
    {controller && action?.kind === 'delete' && <DeleteModelDialog connection={action.connection} controller={controller} state={state} close={close} />}
  </article>;
}
