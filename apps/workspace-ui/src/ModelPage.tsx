import { ModelConnectionTest } from './ModelConnectionTest.tsx';
import { ModelDiscoveryAction, ModelDiscoveryPanel } from './ModelDiscovery.tsx';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { ModelDraft, SavedModelConnection } from '../../../packages/contracts/src/models.ts';
import { ModelConnectionFields, ModelEntryCard, ModelField, modelName } from './ModelConnectionEditor.tsx';
import { emptyModelState, keyNeedsDecision, modelPresets, modelProtocols, type ModelWorkspaceController, type ModelWorkspaceState } from './model-state.ts';

const noop = () => () => {};
const empty = () => emptyModelState;
const credentialStatus = (saved?: SavedModelConnection) => saved ? ({ missing: '缺少 Key', 'not-required': '本机无鉴权', 'reference-present': '已绑定 Key' })[saved.credentialState] : '未保存';
const clearDefault = '__clear__'; // Cannot be a valid connection ID (starts with underscore).

function ConnectionCard({ id, saved, state, controller }: { id: string; saved?: SavedModelConnection; state: ModelWorkspaceState; controller: ModelWorkspaceController }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [replacement, setReplacement] = useState('');
  const draft = state.drafts.get(id), connection = draft?.edit ?? saved!;
  const expanded = state.expanded.has(id), isGlobal = state.configuration?.defaultConnectionID === id;
  const busy = !!state.operation, awaitingKey = state.operation?.kind === 'key' && state.operation.id === id;
  const blocked = busy || state.needsRefresh || state.requiresRestart, stale = controller.stale(id);
  const savedDefault = saved?.models.find(entry => entry.entryID === saved.defaultModelEntryID);
  const feedback = state.feedback?.id === id ? state.feedback : undefined;
  const decision = draft && keyNeedsDecision(draft, saved);
  const region = useId();
  const alternatives = state.configuration?.connections.filter(item => item.id !== id) ?? [];
  return <article className="model-connection">
    <div className="model-connection-top">
      <h2><button type="button" className="model-disclosure" aria-expanded={expanded} aria-controls={region} onClick={() => { if (expanded) setConfirmDelete(false); controller.toggleConnection(id); }}>
        <span aria-hidden="true" className="model-chevron">{expanded ? '▾' : '▸'}</span><span><strong>{connection.displayName || '未命名连接'}</strong><small>{modelProtocols[connection.apiProtocol]} · {connection.models.length} 个模型</small></span>
      </button></h2>
      <div className="model-chips">{isGlobal && <span className="model-chip accent">全局默认</span>}{draft && <span className="model-chip">草稿</span>}<span className="model-chip">{credentialStatus(saved)}</span></div>
    </div>
    <div id={region} className="model-connection-body" hidden={!expanded}>{expanded && <>
      {saved && <div className="model-saved"><p><strong>已保存地址</strong> {saved.baseURL}</p><p><strong>连接默认</strong> {savedDefault ? modelName(savedDefault) : '未设置'}</p></div>}
      {stale && <div className="model-inline" role="status"><p>{saved ? '此连接的已保存版本已变更。保留当前草稿以便核对；继续编辑前需载入最新版本。' : '此连接已被移除；草稿仍保留供核对。'}</p>
        {saved && <button type="button" className="button secondary" disabled={blocked} onClick={() => controller.reloadDraft(id)}>丢弃草稿并载入最新版本</button>}</div>}
      {draft && <>
        <fieldset className="model-fieldset" disabled={blocked || stale}>
          <ModelConnectionFields draft={connection} onEdit={(...args) => controller.patch(...args)} onProtocol={(...args) => controller.changeProtocol(...args)} />
          {draft.proposedProtocol && <div className="model-inline"><p>切换至 {modelProtocols[draft.proposedProtocol]} 会清除连接及模型的 Chat Completions 输出预算字段，保留接入地址和模型目录。</p>
            <div className="model-actions"><button type="button" className="button secondary" onClick={() => controller.cancelProtocol(id)}>保留原协议</button>
              <button type="button" className="button" onClick={() => controller.confirmProtocol(id)}>清除兼容项并切换</button></div></div>}
          <div className="model-inline">
            <p><strong>API Key</strong> · {draft.detach ? '保存时解除绑定' : credentialStatus(saved)}</p>
            {decision && <p>此草稿已更改地址、协议或鉴权。请使用新 Key 保存，或明确解除旧绑定后保存。</p>}
            {saved?.credentialState === 'reference-present' && <><label className="model-check"><input type="checkbox" checked={draft.detach} onChange={event => controller.detachKey(id, event.currentTarget.checked)} /> 保存时解除旧 Key 绑定</label><p className="model-note">解除绑定后该连接不再使用旧 Key；旧钥匙串条目仍保留。</p></>}
            {connection.authMode === 'apiKey' && <p className="model-note">先复制当前连接的 API Key，再点击「从剪贴板保存」；应用只会在你选择 macOS「模型」菜单中的确认项后读取一次。</p>}
          </div>
        </fieldset>
      </>}
      <div className="model-catalog-heading"><h3>模型目录</h3><div className="model-actions">
        {draft && <button type="button" className="button secondary" disabled={blocked || stale || connection.models.length >= 33} onClick={() => controller.addEntry(id)}>添加模型</button>}
        <ModelDiscoveryAction id={id} discovery={state.discovery} controller={controller} confirmingDelete={confirmDelete} />
      </div></div>
      <ModelDiscoveryPanel id={id} discovery={state.discovery} controller={controller} models={connection.models} />
      {draft && <fieldset className="model-fieldset model-local-default" disabled={blocked || stale}>
        <ModelField label="连接默认模型"><select value={connection.defaultModelEntryID} onChange={event => controller.patch(id, { defaultModelEntryID: event.currentTarget.value })}>
          {connection.models.map(entry => <option key={entry.entryID} value={entry.entryID}>{modelName(entry)}</option>)}
        </select></ModelField>
      </fieldset>}
      <div className="model-entry-list">{connection.models.map(entry => <ModelEntryCard key={entry.entryID} connection={connection} entry={entry}
        editable={!!draft} blocked={blocked || stale} controller={controller} expanded={state.expandedModels.get(id)?.has(entry.entryID) ?? false} />)}</div>
      {awaitingKey && <div className="model-inline" role="status"><p>请在 macOS 菜单栏选择「模型 → 保存剪贴板中的 API Key」，核对菜单中的目标站点。等待确认超过 45 秒会取消；提交开始后请等待保存结果。</p>
        <button type="button" className="button secondary" onClick={() => controller.leave()}>取消等待</button></div>}
      {feedback && <p className={feedback.error ? 'model-alert' : 'model-note'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      <div className="model-actions model-footer">
        {draft ? <>
          <button type="button" className="button secondary" disabled={busy} onClick={() => controller.cancel(id)}>取消编辑</button>
          <button type="button" className="button secondary" disabled={blocked || stale || !!draft.proposedProtocol || draft.detach || connection.authMode !== 'apiKey'} onClick={() => { void controller.save(id, true); }}>从剪贴板保存</button>
          <button type="button" className="button" disabled={blocked || stale || !!draft.proposedProtocol || (!!decision && !draft.detach)} onClick={() => { void controller.save(id); }}>{draft.isNew && connection.authMode === 'apiKey' ? '先保存配置' : '保存配置'}</button>
        </> : <button type="button" className="button" disabled={blocked || confirmDelete} onClick={() => controller.edit(id)}>编辑连接</button>}
        <ModelConnectionTest id={id} current={state.connectionTest} savedAddress={saved?.baseURL} controller={controller} confirmingDelete={confirmDelete} />
        {saved && <><button type="button" className="button secondary" disabled={blocked || isGlobal || confirmDelete} onClick={() => { void controller.setDefault(id); }}>设已保存版本为全局默认</button>
          <button type="button" className="button secondary" disabled={blocked || confirmDelete} onClick={() => { controller.cancelDiscovery(id); controller.cancelConnectionTest(id); setReplacement(''); setConfirmDelete(true); }}>删除连接</button></>}
      </div>
      {confirmDelete && saved && <div className="model-inline" aria-label="确认删除连接">
        <p>从本地配置移除此连接{draft ? '，并丢弃该连接的草稿' : ''}。已存 Key 条目会保留。</p>
        {isGlobal && <ModelField label="删除后使用的全局默认"><select value={replacement} disabled={blocked} onChange={event => setReplacement(event.currentTarget.value)}>
          <option value="">请选择</option><option value={clearDefault}>清空全局默认</option>{alternatives.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select></ModelField>}
        <div className="model-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>保留连接</button>
          <button type="button" className="button destructive" disabled={blocked || (isGlobal && !replacement)} onClick={() => { void controller.remove(id, isGlobal ? replacement === clearDefault ? null : replacement : undefined); }}>确认删除连接</button></div>
      </div>}
    </>}</div>
  </article>;
}

export function ModelPage({ controller }: { controller?: ModelWorkspaceController }) {
  const state = useSyncExternalStore(controller?.subscribe ?? noop, controller?.getSnapshot ?? empty, controller?.getSnapshot ?? empty);
  useEffect(() => { controller?.open(); return () => controller?.leave(); }, [controller]);
  const [preset, setPreset] = useState<Exclude<ModelDraft['preset'], 'custom'>>('openai');
  const [clearing, setClearing] = useState(false);
  const config = state.configuration, busy = !!state.operation;
  const current = config?.connections.find(item => item.id === config.defaultConnectionID);
  const currentModel = current?.models.find(item => item.entryID === current.defaultModelEntryID);
  const ids = [...new Set([...(config?.connections.map(item => item.id) ?? []), ...state.drafts.keys()])];
  const available = controller?.available;
  const atLimit = (config?.connections.length ?? 0) + [...state.drafts.values()].filter(draft => draft.isNew).length >= 32;
  return <div className="model-page">
    <header className="page-heading"><div><h1>模型管理<span className="heading-dot">.</span></h1></div><span className="badge">{available ? '本地配置' : '当前不可用'}</span></header>
    {!available || !controller ? <section className="planned-page"><h2>模型管理当前不可用</h2><p>本地管理现仅在已接入受限凭证入口的 macOS 工作区开放。</p></section> : <>
      <section className="model-overview" aria-label="全局默认">
        <div><h2>当前全局默认</h2><p>{current && currentModel ? `${current.displayName} / ${modelName(currentModel)}` : config ? '尚未设置' : '等待读取配置'}</p></div>
        <div className="model-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { void controller.load(); }}>{busy && state.operation?.kind === 'load' ? '读取中…' : '重新读取'}</button>
          {current && !clearing && <button type="button" className="button secondary" disabled={busy || state.needsRefresh || state.requiresRestart} onClick={() => setClearing(true)}>清空全局默认</button>}</div>
        {current && clearing && <div className="model-inline"><p>清空后不会自动选用其他连接，依赖默认路由的功能将不可用。</p><div className="model-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => setClearing(false)}>保留默认</button>
          <button type="button" className="button destructive" disabled={busy || state.needsRefresh || state.requiresRestart} onClick={() => { setClearing(false); void controller.setDefault(null); }}>确认清空</button></div></div>}
      </section>
      <p className="model-note">可为不同协议和账号分开建连接。离开页面会保留草稿，关闭工作区会丢弃未保存内容。保存配置不会发起在线请求。</p>
      {state.feedback && (!state.feedback.id || !state.expanded.has(state.feedback.id)) && <p className={state.feedback.error ? 'model-alert' : 'model-note'} role={state.feedback.error ? 'alert' : 'status'}>{state.feedback.text}</p>}
      {state.requiresRestart && <p className="model-alert" role="status">重启前只读。可读取经校验的磁盘配置来核对；请先记下需要保留的草稿内容，再重启工作区恢复写入。</p>}
      {config && <>
        {ids.length === 0 && <p className="model-empty">还没有服务连接。添加一条连接并手工填写第一个模型。</p>}
        <div className="model-list">{ids.map(id => <ConnectionCard key={id} id={id} saved={config.connections.find(item => item.id === id)} state={state} controller={controller} />)}</div>
        <fieldset className="model-add model-fieldset" disabled={busy || state.needsRefresh || state.requiresRestart || atLimit}>
          <ModelField label="新连接的厂商"><select value={preset} onChange={event => setPreset(event.currentTarget.value as typeof preset)}>
            {Object.entries(modelPresets).filter(([id]) => id !== 'custom').map(([id, item]) => <option value={id} key={id}>{item.name}</option>)}
          </select></ModelField>
          <button type="button" className="button" onClick={() => controller.add(preset)}>添加厂商连接</button>
          <button type="button" className="button secondary" onClick={() => controller.add('custom')}>添加自定义连接</button>
        </fieldset>
        {atLimit && <p className="model-note">连接数量已达上限（含新建草稿）。</p>}
      </>}
    </>}
  </div>;
}
