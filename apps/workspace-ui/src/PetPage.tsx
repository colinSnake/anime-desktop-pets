import { lazy, Suspense, useId, useState, type ReactNode } from 'react';
import { isDafeiyu, longmei, samePetPackage } from '../../../packages/contracts/src/built-in-pets.ts';
import { PetNookIcon } from './PetNookIcon.tsx';
import type { PackageReference, PetPhase, WorkspaceData } from '../../../packages/contracts/src/pets.ts';
import { PetCover, petArt } from './PetCover.tsx';
import { PetCardMore } from './PetCardMore.tsx';
import { isDraftDirty, petDisplayName, type PetWorkspaceController, type PetWorkspaceState } from './pet-state.ts';

const PetSettings = lazy(() => import('./routes/pet-settings.ts'));

type Pet = WorkspaceData['instances'][number];
const phaseNames: Record<PetPhase, string> = {
  'not-connected': '未接入播放器', stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', failed: '运行失败',
};

function PetPhaseLabel({ phase }: { phase: PetPhase }) {
  return <span className="pet-phase" data-phase={phase}><span className="status-dot" aria-hidden="true" />{phaseNames[phase]}</span>;
}

const unavailableMessage = (reference: PackageReference) => samePetPackage(reference, longmei)
  ? '龙妹视频素材暂不可用。请运行 pnpm run dev:desktop --check 检查。'
  : isDafeiyu(reference) ? '大肥鱼本机素材未就绪。请准备素材后重开工作区。' : '素材已导入，播放器暂不支持启动。';

function PetFeedback({ pet, state }: { pet: Pet; state: PetWorkspaceState }) {
  const unavailable = state.workspace?.catalog.some(entry => entry.id === pet.package.id && entry.version === pet.package.version && entry.launchable === false);
  return <>
    {isDraftDirty(state, pet.id) && <p className="pet-instance-note draft-marker">未保存</p>}
    {pet.phase === 'failed' && <p className="pet-instance-note error" role="alert">运行失败，请确认停止后重试。</p>}
    {unavailable && <p className="pet-instance-note error">{unavailableMessage(pet.package)}</p>}
    {pet.positionFeedback?.status === 'failed' && <p className="pet-instance-note error" role="alert">位置保存失败，保留上次成功位置。</p>}
    {pet.menuFeedback === 'rollback-failed' && <p className="pet-instance-note error" role="alert">右键设置未保存，运行值可能与保存值不同。</p>}
    {pet.behavior?.status === 'failed' && <p className="pet-instance-note error" role="alert">行为应用失败，请在设置中重试。</p>}
  </>;
}

const linkageLabels: Record<WorkspaceData['linkage'], string> = {
  active: '暂停联动', paused: '解除暂停', pausing: '正在暂停…', 'stop-unconfirmed': '重试暂停',
};

export function PetPage({ state, controller, appearance }: { state: PetWorkspaceState; controller?: PetWorkspaceController; appearance?: ReactNode }) {
  const [showCatalog, setShowCatalog] = useState(false);
  const [showCompanion, setShowCompanion] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const catalogId = useId();
  const stageTitle = useId();
  const listTitle = useId();
  const workspace = state.workspace;
  const entries = workspace?.instances ?? [];
  const catalog = workspace?.catalog ?? [];
  const availableCompanion = catalog.find(entry => isDafeiyu(entry) && entry.launchable === true && !entries.some(pet => isDafeiyu(pet.package)));
  const selectedCompanion = availableCompanion && (showCompanion || !entries.length) ? availableCompanion : undefined;
  const selected = selectedCompanion ? undefined : entries.find(pet => pet.id === state.selectedId) ?? entries[0];
  const reference = selectedCompanion ?? selected?.package;
  const art = reference ? petArt(reference) : 'default';
  const members = entries.length + Number(!!availableCompanion);
  const busy = !!state.operation;
  const blocked = busy || state.needsRefresh || !controller;
  const atLimit = entries.length >= 32;
  const name = selectedCompanion?.name ?? (selected ? petDisplayName(selected, workspace) : '');
  const line = selectedCompanion ? '准备好啦，添加后就能在桌边见面。' : art === 'dafeiyu' ? '今天也在桌边慢慢游。'
    : selected && entries.find(pet => samePetPackage(pet.package, selected.package)) !== selected ? '独立的桌宠实例，与原角色共用形象。'
    : art === 'longmei' ? '今天也一起待在桌边。' : '让喜欢的角色，陪在桌边。';
  const stopped = selected?.phase === 'stopped' || selected?.phase === 'not-connected';
  const canStart = selected?.phase === 'stopped' && selected.enabled && workspace?.linkage === 'active' &&
    catalog.find(entry => entry.id === selected.package.id && entry.version === selected.package.version)?.launchable !== false;
  const actionLabel = stopped ? '启动桌宠' : selected?.phase === 'starting' ? '取消启动' : selected?.phase === 'failed' ? '确认停止' : selected?.phase === 'stopping' ? '等待退出…' : '停止桌宠';
  // Keep all settings and commands on the existing controller's instance and revision boundaries.
  const target = (action: (owner: PetWorkspaceController) => void) => {
    if (!busy && controller && selected) { controller.select(selected.id); action(controller); }
  };

  return <div className="pet-nook">
    <header className="page-heading pet-page-heading">
      <div><h1>桌宠</h1><p className="muted">让喜欢的角色，陪在桌边。</p></div>
      <div className="button-row pet-page-tools" role="group" aria-label="桌宠控制">
        {appearance}
        <button className="button secondary compact pet-add" aria-expanded={showCatalog} aria-controls={showCatalog ? catalogId : undefined} disabled={blocked || atLimit} onClick={() => setShowCatalog(value => !value)}><PetNookIcon name="plus" />添加桌宠</button>
      </div>
    </header>
    {workspace?.linkage === 'paused' && <p className="pet-page-notice muted">已暂停，解除后需逐个手动启动。</p>}
    {workspace?.linkage === 'stop-unconfirmed' && <p className="pet-page-notice error" role="alert">停止未确认，门禁保持关闭。</p>}
    {state.runtimeStale && <p className="pet-page-notice error" role="alert">运行状态刷新失败，请刷新后核对。</p>}
    {showCatalog && <section id={catalogId} className="catalog-panel" aria-label="添加桌宠">
      <div className="catalog-heading"><h2>选择桌宠</h2><button className="button secondary compact" disabled={blocked || catalog.length >= 32} onClick={() => { void controller?.importPackages(); }}>{state.operation === 'importPackages' ? '正在校验…' : '导入素材'}</button></div>
      {state.notice && <p className="catalog-feedback" role="status" aria-live="polite">{state.notice}</p>}
      {catalog.length ? <ul>{catalog.map(entry => <li key={`${entry.id}@${entry.version}`}>
        <div><strong>{entry.name}</strong>{entry.launchable === false && <small>{unavailableMessage(entry)}</small>}</div>
        <button className="button secondary compact" disabled={blocked || atLimit || (isDafeiyu(entry) && entry.launchable !== true)} onClick={() => { void controller?.add({ id: entry.id, version: entry.version }).then(success => { if (success) { setShowCatalog(false); setShowCompanion(false); } }); }}>添加「{entry.name}」</button>
      </li>)}</ul> : <p>还没有可添加的桌宠素材。</p>}
    </section>}
    {reference ? <section className="pet-stage" data-pet-art={art} aria-labelledby={stageTitle}>
      <div className="pet-stage-copy">
        <p className="pet-stage-kicker"><PetNookIcon name="spark" /> {selectedCompanion ? '桌宠预览' : '当前桌宠'}</p>
        <h2 id={stageTitle}>{name}</h2>
        <div className="pet-stage-status">{selected ? <PetPhaseLabel phase={selected.phase} /> : <span className="pet-phase"><span className="status-dot" aria-hidden="true" />可添加</span>}</div>
        <p className="pet-stage-line">{line}</p>
        <div className="pet-stage-actions">
          {selectedCompanion && <button className="button primary compact" disabled={blocked || atLimit} onClick={() => { void controller?.add(selectedCompanion).then(success => { if (success) setShowCompanion(false); }); }}>添加大肥鱼</button>}
          {selected && <>
            <button className="button primary compact" disabled={blocked || selected.phase === 'stopping' || (stopped && !canStart)} onClick={() => target(owner => { void owner.control(stopped ? 'start' : 'stop'); })}>{actionLabel}</button>
            <button className="button secondary compact" id={`pet-settings-${selected.id}`} aria-label={`设置${name}`} aria-haspopup="dialog" disabled={busy || !controller} onClick={() => target(() => setShowSettings(true))}>设置</button>
            <PetCardMore key={selected.id} name={name} disabled={blocked} cloneDisabled={blocked || atLimit} deleteDisabled={blocked || !stopped} onClone={() => target(owner => { void owner.clone(); })} onDelete={() => target(owner => owner.requestDelete())} />
          </>}
        </div>
        {selected && <PetFeedback pet={selected} state={state} />}
      </div>
      <div className="pet-stage-art">
        <span className="pet-stage-orbits" aria-hidden="true" />
        <span className="pet-stage-glow" aria-hidden="true" />
        <PetNookIcon name="spark" className="pet-stage-spark pet-stage-spark-a" />
        <PetNookIcon name="spark" className="pet-stage-spark pet-stage-spark-b" />
        <PetNookIcon name="spark" className="pet-stage-spark pet-stage-spark-c" />
        <PetCover reference={reference} />
      </div>
    </section> : <div className="pet-empty">
      <img src="./assets/app-icon.svg" width="64" height="64" alt="" />
      <p>{workspace ? '还没有桌宠，添加一只开始陪伴。' : '尚未连接桌面宿主。'}</p>
    </div>}
    {members > 1 && <section className="pet-members" aria-labelledby={listTitle}>
      <header><h2 id={listTitle}>全部桌宠 <span>{members}</span></h2><p className="muted">点选角色，切换舞台</p></header>
      <ul aria-label="桌宠实例列表">{entries.map(pet => {
        const label = petDisplayName(pet, workspace);
        const current = pet.id === selected?.id;
        return <li key={pet.id}>
          <button className="pet-member" type="button" data-pet-art={petArt(pet.package)} aria-pressed={current} disabled={busy || !controller} onClick={() => { setShowCompanion(false); controller?.select(pet.id); }}>
            <PetCover reference={pet.package} avatar />
            <span className="pet-member-name">{label}</span><PetPhaseLabel phase={pet.phase} />
            <PetNookIcon name="chevron" className="pet-member-chevron" />
          </button>
          {!current && <PetFeedback pet={pet} state={state} />}
        </li>;
      })}{availableCompanion && <li key={availableCompanion.id}>
        <button className="pet-member" type="button" data-pet-art="dafeiyu" aria-pressed={!!selectedCompanion} disabled={busy || !controller} onClick={() => setShowCompanion(true)}>
          <PetCover reference={availableCompanion} avatar />
          <span className="pet-member-name">{availableCompanion.name}</span><span className="pet-phase"><span className="status-dot" aria-hidden="true" />可添加</span>
          <PetNookIcon name="chevron" className="pet-member-chevron" />
        </button>
      </li>}</ul>
    </section>}
    {art === 'dafeiyu' && <p className="pet-credit">社区角色 · 原型「溟月」：上善无形 · 女仆鲸鱼娘设计：ZipZipPipe · CC BY-NC-SA 4.0</p>}
    {workspace && <div className="button-row pet-workspace-tools" role="group" aria-label="桌宠控制">
      <button className="button secondary compact" disabled={busy || !controller} onClick={() => { void controller?.load(); }}>{state.operation === 'load' ? '读取中…' : '刷新'}</button>
      <button className="button secondary compact" disabled={blocked || workspace.linkage === 'pausing'} onClick={() => { void controller?.controlLinkage(workspace.linkage === 'paused' ? 'resume' : 'pause'); }}>{linkageLabels[workspace.linkage]}</button>
    </div>}
    {showSettings && <Suspense fallback={<p role="status" className="sr-only">正在加载桌宠设置…</p>}><PetSettings state={state} controller={controller} onClose={() => setShowSettings(false)} /></Suspense>}
  </div>;
}
