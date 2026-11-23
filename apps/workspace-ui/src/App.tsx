import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DialogCloseButton, useDialogDismiss } from './DialogDismiss.tsx';
import type { DesktopBridge, Snapshot } from '../../../packages/contracts/src/index.ts';
import { ModelWorkspaceController } from './model-state.ts';
import type { ChatWorkspaceController, ChatWorkspaceState } from './chat-session.ts';
import { emptyChatState } from './empty-chat.ts';
import { ThemeToggle } from './ThemeToggle.tsx';
import { loadSnapshot } from './client.ts';
import type { DiagnosticProps } from './Diagnostics.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import { PetPage } from './PetPage.tsx';
import { PetWorkspaceController, emptyPetState, isDraftDirty, petDisplayName, type PetWorkspaceState } from './pet-state.ts';
import { petErrorMessages } from './pet-client.ts';
import { PageLoadingSkeleton } from './PageLoadingSkeleton.tsx';

declare global { interface Window { petDesktop?: DesktopBridge } }
const loadChat = () => import('./routes/chat.ts');
const ChatPage = lazy(loadChat);
const noSubscription = () => () => {};
const getEmptyChatState = () => emptyChatState;
const ModelPage = lazy(() => import('./routes/models.ts'));
const WorkspaceModules = lazy(() => import('./routes/workspace-modules.ts'));
const groups = [
  { name: '陪伴', pages: [{ id: 'pets', label: '桌宠' }, { id: 'chat', label: '聊天' }] },
  { name: '设置', pages: [{ id: 'models', label: '模型管理' }, { id: 'speech', label: '语音互动' }, { id: 'live', label: '直播管理' }, { id: 'advanced', label: '高级' }] },
] as const;
// The old page keys remain usable for offline module rendering, not navigation.
const rolePages = [{ id: 'identity', label: '身份' }, { id: 'memory', label: '记忆' }, { id: 'goals', label: '能力与目标' }] as const;
type Page = typeof groups[number]['pages'][number]['id'] | typeof rolePages[number]['id'];
const isModulePage = (page: Page) => page !== 'pets' && page !== 'chat' && page !== 'models';
type ViewProps = DiagnosticProps & { petState?: PetWorkspaceState; petController?: PetWorkspaceController; initialPage?: Page; chatState?: ChatWorkspaceState; chatController?: ChatWorkspaceController; chatHistory?: DesktopBridge['chatHistory']; agentTasks?: DesktopBridge['agentTasks']; onChatOpen?: () => void; modelController?: ModelWorkspaceController; speech?: DesktopBridge['speech']; characters?: DesktopBridge['characters']; openWorkspaceData?: DesktopBridge['openWorkspaceData']; migrateWorkspaceData?: DesktopBridge['migrateWorkspaceData'] };

/** Kept exported for offline rendering; diagnostics are now explicitly under Advanced. */
export function WorkspaceView({ petState = emptyPetState, petController, initialPage = 'pets', chatState = emptyChatState, chatController, chatHistory, agentTasks, onChatOpen, modelController, speech, characters, openWorkspaceData, migrateWorkspaceData, ...diagnostics }: ViewProps) {
  const [page, setPage] = useState<Page>(initialPage);
  const [visitedModules, setVisitedModules] = useState(() => isModulePage(initialPage));
  const headingRef = useRef<HTMLElement>(null);
  const [openAgent, setOpenAgent] = useState<{ petID: string; opener: HTMLElement }>();
  const chatCharacter = chatState.characters.find(character => character.id === chatState.selectedId);
  const chatInstance = !petState.needsRefresh && chatCharacter ? petState.workspace?.instances.find(pet => pet.id === chatCharacter.id) : undefined;
  const activeAgent = openAgent && page === 'chat' && chatInstance?.id === openAgent.petID && !petState.deleteId ? openAgent : undefined;
  useEffect(() => { if (!activeAgent && openAgent) setOpenAgent(undefined); }, [activeAgent, openAgent]);
  const changePage = (next: Page) => {
    if (page === 'models' && next !== 'models') modelController?.leave();
    if (page === 'chat' && next !== 'chat') chatController?.cancel();
    if (next === 'chat') onChatOpen?.();
    if (isModulePage(next)) setVisitedModules(true);
    setPage(next);
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, left: 0 });
    });
  };
  const deletePet = petState.workspace?.instances.find(pet => pet.id === petState.deleteId);
  const error = petState.error ? petErrorMessages[petState.error] : '';
  const busy = !!petState.operation;
  const current = [...groups.flatMap(group => [...group.pages]), ...rolePages].find(entry => entry.id === page)!;
  const inNook = page === 'pets';
  const inChat = page === 'chat';
  const companionLayout = inNook || inChat;
  const interactionLayout = page === 'speech' || page === 'live' || page === 'advanced';
  const nookStyle = companionLayout || interactionLayout || page === 'models';
  const theme = <div className="workspace-topline-actions"><ThemeToggle showLabel={companionLayout || interactionLayout} theme={petState.workspace?.theme ?? 'system'} disabled={busy || petState.needsRefresh || !petState.workspace || !petController} onChange={value => { void petController?.setTheme(value); }} /></div>;
  return <div className={`workspace${nookStyle ? ' workspace-nook' : ''}${inChat ? ' workspace-chat' : ''}`} data-theme={petState.workspace?.theme ?? 'system'}>
    <div className="shell-layout" inert={!!petState.deleteId}>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <aside className="sidebar" aria-label="工作区侧栏">
        <button className="brand" onClick={() => changePage('pets')}>
          <img className="brand-mark" src="./assets/app-icon.svg" alt="" draggable={false} />
          <span><span>桌边小崽</span><small aria-hidden="true">桌边小窝</small></span>
        </button>
        <nav aria-label="工作区导航">{groups.map(group => <section className="nav-group" key={group.name} aria-label={group.name}>
          <h2>{group.name}</h2><ul>{group.pages.map(entry => <li key={entry.id}>
            <button className="nav-item" aria-current={page === entry.id ? 'page' : undefined} onClick={() => changePage(entry.id)}>
              <span className="nav-icon" aria-hidden="true"><PetNookIcon name={entry.id} /></span>{entry.label}
            </button>
          </li>)}</ul>
        </section>)}</nav>
      </aside>
      <main id="main" className={`content${page === 'chat' ? ' content-chat' : interactionLayout ? ' content-interaction' : ''}`} ref={headingRef} tabIndex={-1}>
        <div className="workspace-topline">
          <nav className="workspace-breadcrumb" aria-label="当前位置">
            <ol role="list">
              <li className="workspace-crumb-root">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
                  <rect x="2" y="2" width="4.5" height="4.5" rx="1" /><rect x="9.5" y="2" width="4.5" height="4.5" rx="1" />
                  <rect x="2" y="9.5" width="4.5" height="4.5" rx="1" /><rect x="9.5" y="9.5" width="4.5" height="4.5" rx="1" />
                </svg>
                <span>工作区</span>
              </li>
              <li className="workspace-crumb-page">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 2.75 3.25 3.25-3.25 3.25" /></svg>
                <span className="workspace-crumb-current" aria-current="page">{current.label}</span>
              </li>
            </ol>
          </nav>
          {!nookStyle && theme}
        </div>
        <div className={`feedback${error || busy ? ' visible' : ''}`} aria-live="polite" aria-atomic="true">{error ? <p role="alert" className="error">{error}</p> : petState.notice ? <p className="sr-only">{petState.notice}</p> : busy ? <p>{({ load: '正在读取配置', importPackages: '正在导入并校验素材', save: '正在保存配置', add: '正在登记配置', clone: '正在复制配置', delete: '正在删除配置', theme: '正在保存主题', start: '正在请求启动实例', stop: '正在请求停止实例', applyDisplay: '正在应用显示偏好', applyBehavior: '正在应用行为偏好', visibility: '正在调整窗口显隐', pause: '正在暂停自有播放器', resume: '正在解除暂停' } as const)[petState.operation!] ?? '正在处理'}…</p> : null}</div>
        <Suspense fallback={<PageLoadingSkeleton />}>
          {page === 'pets' ? <PetPage appearance={theme} state={petState} controller={petController} /> : page === 'chat' ? <ChatPage state={chatState} controller={chatController} history={chatHistory} agentTasks={agentTasks} appearance={theme} onOpenPets={() => changePage('pets')}
            onOpenPetAgent={chatInstance && !petState.deleteId ? opener => { setVisitedModules(true); setOpenAgent({ petID: chatInstance.id, opener }); } : undefined}
            reference={chatInstance?.package} /> : page === 'models' ? <ModelPage controller={modelController} appearance={theme} /> : null}
        </Suspense>
        {/* Mount on first visit, then retain the module drafts across navigation. */}
        {visitedModules && <Suspense fallback={isModulePage(page) || activeAgent ? <PageLoadingSkeleton /> : null}>
          <WorkspaceModules page={activeAgent ? 'agent' : isModulePage(page) ? page : null} workspace={petState.workspace} diagnostics={diagnostics} speech={speech} appearance={interactionLayout ? theme : undefined} characters={characters} openWorkspaceData={openWorkspaceData} migrateWorkspaceData={migrateWorkspaceData}
            agent={activeAgent && chatCharacter ? { name: chatCharacter.name, opener: activeAgent.opener, chat: chatState, onClose: () => setOpenAgent(undefined) } : undefined}
            selectedInstance={activeAgent ? chatInstance : petState.needsRefresh ? undefined : petState.workspace?.instances.find(pet => pet.id === petState.selectedId)} />
        </Suspense>}

      </main>
    </div>
    {petState.deleteId && <Confirmation key={petState.deleteId} title={`删除「${deletePet ? petDisplayName(deletePet, petState.workspace) : petState.deleteId}」的配置？`} busy={petState.operation === 'delete'} error={error} onCancel={() => petController?.cancelDelete()} onConfirm={() => { void petController?.confirmDelete(); }} blocked={busy || petState.needsRefresh}>
      <p>只删除这个实例的配置，不会删除素材、历史数据或任何旧资料，也不会结束正在运行的桌宠。</p>
      {isDraftDirty(petState, petState.deleteId) && <p className="delete-warning">此实例还有未保存的修改。删除配置也会丢弃这份草稿。</p>}
    </Confirmation>}
  </div>;
}
function Confirmation({ title, children, busy, blocked, error, onCancel, onConfirm }: { title: string; children: ReactNode; busy: boolean; blocked: boolean; error: string; onCancel(): void; onConfirm(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const dismiss = useDialogDismiss(onCancel, busy);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current!;
    dialog.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length && !previous.matches(':disabled')) {
        previous.focus({ preventScroll: true });
      } else document.getElementById('main')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog className="confirmation" role="dialog" aria-labelledby="delete-title" aria-describedby="delete-description" aria-busy={busy} ref={ref} {...dismiss}>
    <header className="dialog-title-row"><h2 id="delete-title">{title}</h2><DialogCloseButton disabled={busy} onClose={onCancel} /></header>
    <div id="delete-description">{children}</div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="button-row"><button type="button" className="button secondary" ref={cancel} disabled={busy} onClick={onCancel}>保留配置</button><button type="button" className="button destructive" disabled={blocked} onClick={onConfirm}>{busy ? '删除中…' : '只删除实例配置'}</button></div>
  </dialog>;
}

export function App() {
  const [controller] = useState(() => new PetWorkspaceController(window.petDesktop?.pets));
  const petState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [chatController, setChatController] = useState<ChatWorkspaceController>();
  const [modelController] = useState(() => new ModelWorkspaceController(window.petDesktop?.models));
  const chatState = useSyncExternalStore(chatController?.subscribe ?? noSubscription, chatController?.getSnapshot ?? getEmptyChatState);
  useEffect(() => {
    if (petState.workspace) chatController?.syncCharacters(petState.workspace.instances.map(pet => ({ id: pet.id, name: petDisplayName(pet, petState.workspace) })));
  }, [petState.workspace, chatController]);
  useEffect(() => () => chatController?.cancel(), [chatController]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false), running = useRef(false), sequence = useRef(0);
  function openChat() {
    if (chatController) return;
    // Share the existing lazy route; keep its controller alive after the first visit.
    void loadChat().then(({ ChatWorkspaceController }) => {
      if (!mounted.current) return;
      const { characters, onlineChat, chatHistory } = window.petDesktop ?? {};
      const memory = typeof characters?.saveChatMemory === 'function' && typeof characters.readMemories === 'function' ? characters : undefined;
      setChatController(current => current ?? new ChatWorkspaceController(undefined, characters, onlineChat, memory, !!chatHistory));
    }).catch(() => { /* The lazy page surfaces load failures. */ });
  }
  async function refresh(command: 'snapshot' | 'probe') {
    if (running.current) return;
    const request = ++sequence.current;
    running.current = true;
    setBusy(true); setError('');
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
      const hasRuntime = controller.getSnapshot().workspace?.instances.some(pet => pet.phase !== 'stopped' && pet.phase !== 'not-connected');
      try {
        if (document.visibilityState === 'visible') await controller.refreshRuntime();
      } finally {
        // Menu actions can change linkage even when no instance is running.
        if (!stopped) timer = setTimeout(() => { void tick(); }, hasRuntime ? 1000 : 5000);
      }
    };
    timer = setTimeout(() => { void tick(); }, 1000);
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void controller.refreshRuntime();
    };
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      stopped = true; clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [controller]);
  useEffect(() => {
    mounted.current = true;
    void controller.load();
    void refresh('snapshot');
    return () => { mounted.current = false; sequence.current++; running.current = false; };
  }, [controller]);
  return <WorkspaceView openWorkspaceData={window.petDesktop?.openWorkspaceData} migrateWorkspaceData={window.petDesktop?.migrateWorkspaceData} speech={window.petDesktop?.speech} characters={window.petDesktop?.characters} modelController={modelController} chatState={chatState} chatController={chatController} chatHistory={window.petDesktop?.chatHistory} agentTasks={window.petDesktop?.agentTasks} onChatOpen={openChat} petState={petState} petController={controller} snapshot={snapshot} busy={busy} error={error} onRefresh={() => { void refresh('snapshot'); }} onProbe={() => { void refresh('probe'); }} />;
}
