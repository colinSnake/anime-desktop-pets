import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DesktopBridge, Snapshot } from '../../../packages/contracts/src/index.ts';
import { ModelPage } from './ModelPage.tsx';
import { ModelWorkspaceController } from './model-state.ts';
import { ChatPage } from './ChatPage.tsx';
import { ChatWorkspaceController, emptyChatState, type ChatWorkspaceState } from './chat-session.ts';
import { ThemeToggle } from './ThemeToggle.tsx';
import { loadSnapshot } from './client.ts';
import type { DiagnosticProps } from './Diagnostics.tsx';
import { WorkspaceModules } from './pages/WorkspaceModules.tsx';
import { PetPage } from './PetPage.tsx';
import { PetWorkspaceController, emptyPetState, isDraftDirty, petDisplayName, type PetWorkspaceState } from './pet-state.ts';
import { petErrorMessages } from './pet-client.ts';

declare global { interface Window { petDesktop?: DesktopBridge } }
const groups = [
  { name: '陪伴', pages: [{ id: 'pets', label: '我的桌宠', icon: '◈' }, { id: 'chat', label: '聊天', icon: '◌' }] },
  { name: '角色', pages: [{ id: 'identity', label: '身份', icon: '◇' }, { id: 'memory', label: '记忆', icon: '▤' }, { id: 'goals', label: '能力与目标', icon: '⌁' }] },
  { name: '设置', pages: [{ id: 'models', label: '模型管理', icon: '⊞' }, { id: 'speech', label: '语音互动', icon: '≋' }, { id: 'live', label: '直播管理', icon: '▻' }, { id: 'advanced', label: '高级', icon: '⚙' }] },
] as const;
type Page = typeof groups[number]['pages'][number]['id'];
type ViewProps = DiagnosticProps & { petState?: PetWorkspaceState; petController?: PetWorkspaceController; initialPage?: Page; chatState?: ChatWorkspaceState; chatController?: ChatWorkspaceController; modelController?: ModelWorkspaceController; speech?: DesktopBridge['speech']; characters?: DesktopBridge['characters'] };

/** Kept exported for offline rendering; diagnostics are now explicitly under Advanced. */
export function WorkspaceView({ petState = emptyPetState, petController, initialPage = 'pets', chatState = emptyChatState, chatController, modelController, speech, characters, ...diagnostics }: ViewProps) {
  const [page, setPage] = useState<Page>(initialPage);
  const headingRef = useRef<HTMLElement>(null);
  const changePage = (next: Page) => {
    if (page === 'models' && next !== 'models') modelController?.leave();
    if (page === 'chat' && next !== 'chat') chatController?.cancel();
    setPage(next);
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, left: 0 });
    });
  };
  const deletePet = petState.workspace?.instances.find(pet => pet.id === petState.deleteId);
  const error = petState.error ? petErrorMessages[petState.error] : '';
  const busy = !!petState.operation;
  const current = groups.flatMap(group => [...group.pages]).find(entry => entry.id === page)!;
  return <div className={`workspace${page === 'chat' ? ' workspace-chat' : ''}`} data-theme={petState.workspace?.theme ?? 'system'}>
    <div className="shell-layout" inert={!!petState.deleteId}>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <aside className="sidebar" aria-label="工作区侧栏">
        <button className="brand" onClick={() => changePage('pets')}><img className="brand-mark" src="./assets/app-icon.svg" alt="" /><span>桌边小崽</span></button>
        <nav aria-label="工作区导航">{groups.map(group => <section className="nav-group" key={group.name} aria-label={group.name}><h2>{group.name}</h2><ul>{group.pages.map(entry => <li key={entry.id}><button className="nav-item" aria-current={page === entry.id ? 'page' : undefined} onClick={() => changePage(entry.id)}><span className="nav-icon" aria-hidden="true">{entry.icon}</span>{entry.label}{entry.id === 'pets' && <span className="nav-dot" aria-hidden="true" />}</button></li>)}</ul></section>)}</nav>

      </aside>
      <main id="main" className={`content${page === 'chat' ? ' content-chat' : ''}`} ref={headingRef} tabIndex={-1}>
        <div className="workspace-topline"><span>工作区 <span aria-hidden="true">/</span> {current.label}</span><div className="workspace-topline-actions"><ThemeToggle theme={petState.workspace?.theme ?? 'system'} disabled={busy || petState.needsRefresh || !petState.workspace || !petController} onChange={theme => { void petController?.setTheme(theme); }} /></div></div>
        <div className={`feedback${error || busy ? ' visible' : ''}`} aria-live="polite" aria-atomic="true">{error ? <p role="alert" className="error">{error}</p> : petState.notice ? <p className="sr-only">{petState.notice}</p> : busy ? <p>{({ load: '正在读取配置', importPackages: '正在导入并校验素材', save: '正在保存配置', add: '正在登记配置', clone: '正在复制配置', delete: '正在删除配置', theme: '正在保存主题', start: '正在请求启动实例', stop: '正在请求停止实例', applyDisplay: '正在应用显示偏好', applyBehavior: '正在应用行为偏好', visibility: '正在调整窗口显隐', pause: '正在暂停自有播放器', resume: '正在解除暂停' } as const)[petState.operation!] ?? '正在处理'}…</p> : null}</div>
        {page === 'pets' ? <PetPage state={petState} controller={petController} /> : page === 'chat' ? <ChatPage state={chatState} controller={chatController} onOpenModels={() => changePage('models')} /> : page === 'models' ? <ModelPage controller={modelController} /> : null}
        <WorkspaceModules page={page === 'pets' || page === 'chat' || page === 'models' ? null : page} workspace={petState.workspace} diagnostics={diagnostics} speech={speech} characters={characters}
          selectedInstance={petState.needsRefresh ? undefined : petState.workspace?.instances.find(pet => pet.id === petState.selectedId)} />

      </main>
    </div>
    {petState.deleteId && <Confirmation key={petState.deleteId} title={`删除「${deletePet ? petDisplayName(deletePet, petState.workspace) : petState.deleteId}」的配置？`} busy={petState.operation === 'delete'} error={error} onCancel={() => petController?.cancelDelete()} onConfirm={() => { void petController?.confirmDelete(); }} blocked={busy || petState.needsRefresh}>
      <p>只删除这个实例的配置，不会删除素材、历史数据或任何旧资料，也不会结束正在运行的桌宠。</p>
      {isDraftDirty(petState, petState.deleteId) && <p className="delete-warning">此实例还有未保存的修改。删除配置也会丢弃这份草稿。</p>}
    </Confirmation>}
  </div>;
}
function Confirmation({ title, children, busy, blocked, error, onCancel, onConfirm }: { title: string; children: ReactNode; busy: boolean; blocked: boolean; error: string; onCancel(): void; onConfirm(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); else document.getElementById('main')?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div className="confirmation" role="dialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description" aria-busy={busy} ref={ref} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel(); }
    if (event.key === 'Tab') {
      const elements = ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = elements?.[0], last = elements?.[elements.length - 1];
      if (!first) { event.preventDefault(); ref.current?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }} tabIndex={-1}><h2 id="delete-title">{title}</h2><div id="delete-description">{children}</div>{error && <p className="error" role="alert">{error}</p>}<div className="button-row"><button className="button secondary" ref={cancel} disabled={busy} onClick={onCancel}>保留配置</button><button className="button destructive" disabled={blocked} onClick={onConfirm}>{busy ? '删除中…' : '只删除实例配置'}</button></div></div></div>;
}

export function App() {
  const [controller] = useState(() => new PetWorkspaceController(window.petDesktop?.pets));
  const petState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [chatController] = useState(() => new ChatWorkspaceController(undefined, window.petDesktop?.characters, window.petDesktop?.onlineChat));
  const [modelController] = useState(() => new ModelWorkspaceController(window.petDesktop?.models));
  const chatState = useSyncExternalStore(chatController.subscribe, chatController.getSnapshot, chatController.getSnapshot);
  useEffect(() => {
    if (petState.workspace) chatController.syncCharacters(petState.workspace.instances.map(pet => ({ id: pet.id, name: petDisplayName(pet, petState.workspace) })));
  }, [petState.workspace, chatController]);
  useEffect(() => () => chatController.cancel(), [chatController]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false), running = useRef(false), sequence = useRef(0);
  async function refresh(command: 'snapshot' | 'probe' | 'start-player' | 'stop-player') {
    if (running.current && command !== 'stop-player') return;
    const request = ++sequence.current;
    running.current = true;
    setBusy(true); setError('');
    if (command === 'start-player' || command === 'stop-player') {
      setSnapshot(previous => previous?.player ? { ...previous, player: { ...previous.player, status: command === 'start-player' ? 'starting' : 'stopping', detail: command === 'start-player' ? '等待首个真实动画帧…' : '等待播放器与解码线程退出…' } } : previous);
    }
    try {
      const next = await loadSnapshot(window.petDesktop, command);
      if (mounted.current && request === sequence.current) setSnapshot(next);
    } catch (failure) {
      if (mounted.current && request === sequence.current) { setSnapshot(undefined); setError(failure instanceof Error ? failure.message : '本地状态读取失败。'); }
    } finally {
      if (request === sequence.current) { running.current = false; if (mounted.current) setBusy(false); }
    }
  }
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const state = controller.getSnapshot();
        if (document.visibilityState === 'visible' && state.workspace?.instances.some(pet => ['starting', 'running', 'stopping', 'failed'].includes(pet.phase))) await controller.refreshRuntime();
      } finally { if (!stopped) timer = setTimeout(() => { void tick(); }, 1000); }
    };
    timer = setTimeout(() => { void tick(); }, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [controller]);
  useEffect(() => {
    mounted.current = true;
    void controller.load();
    void refresh('snapshot');
    return () => { mounted.current = false; sequence.current++; running.current = false; };
  }, [controller]);
  return <WorkspaceView speech={window.petDesktop?.speech} characters={window.petDesktop?.characters} modelController={modelController} chatState={chatState} chatController={chatController} petState={petState} petController={controller} snapshot={snapshot} busy={busy} error={error} onRefresh={() => { void refresh('snapshot'); }} onProbe={() => { void refresh('probe'); }} onStartPlayer={() => { void refresh('start-player'); }} onStopPlayer={() => { void refresh('stop-player'); }} />;
}
