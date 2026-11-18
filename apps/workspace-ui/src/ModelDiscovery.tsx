import { useId } from 'react';
import type { ModelEntry } from '../../../packages/contracts/src/models.ts';
import type { ModelWorkspaceController, ModelWorkspaceState } from './model-state.ts';

type Props = { id: string; discovery?: ModelWorkspaceState['discovery']; controller: ModelWorkspaceController };
export function ModelDiscoveryAction({ id, discovery, controller, confirmingDelete }: Props & { confirmingDelete: boolean }) {
  const description = useId(), reason = controller.discoveryBlockedReason(id);
  const pending = discovery?.id === id && discovery.kind === 'pending';
  return <div className="model-discovery-action">
    <button type="button" className="button secondary" disabled={!!reason || confirmingDelete}
      aria-describedby={reason && !pending ? description : undefined} onClick={() => { void controller.discover(id); }}>
      {pending ? '获取中…' : '获取模型列表'}</button>
    {reason && !pending && <span id={description} className="model-note">{reason}</span>}
  </div>;
}
export function ModelDiscoveryPanel({ id, discovery, controller, models }: Props & { models: ModelEntry[] }) {
  if (discovery?.id !== id) return null;
  const close = () => controller.cancelDiscovery(id);
  if (discovery.kind === 'pending') return <div className="model-inline"><p role="status">正在获取此连接已保存地址的首批模型…</p>
    <button type="button" className="button secondary" onClick={close}>取消获取</button></div>;
  if (discovery.kind === 'error') return <p className="model-alert" role="alert">{discovery.message} 现有目录未更改。</p>;
  const existing = new Set(models.map(model => model.modelID)), over = models.length + discovery.selected.size > 33;
  return <section className="model-inline" aria-label="模型候选">
    <p role="status">{discovery.truncated ? '仅获取了首批，可手工添加其余模型。' : '已返回模型列表。'} 勾选后可加入草稿。</p>
    {discovery.candidates.length ? <ul className="model-candidates">{discovery.candidates.map(item => <li key={item.modelID}>
      <label className="model-check"><input type="checkbox" disabled={existing.has(item.modelID)} checked={discovery.selected.has(item.modelID)}
        onChange={() => controller.toggleCandidate(id, item.modelID)} /><span>{item.displayName} · <code>{item.modelID}</code>{existing.has(item.modelID) ? ' · 已在目录' : ''}</span></label>
    </li>)}</ul> : <p>该列表没有可用候选。可手工添加模型。</p>}
    {over && <p className="model-alert" role="alert">每个连接最多 33 个模型，请减少勾选数量。</p>}
    <div className="model-actions"><button type="button" className="button secondary" onClick={close}>关闭候选</button>
      <button type="button" className="button" disabled={!discovery.selected.size || over} onClick={() => controller.mergeCandidates(id)}>合并到草稿</button></div>
  </section>;
}
