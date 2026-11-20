import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { PackageReference } from '../../../../packages/contracts/src/pets.ts';
import { PetCover, petArt } from '../PetCover.tsx';
import { PetNookIcon } from '../PetNookIcon.tsx';
import type { GoalSession, MemoryMode, MemorySession } from './character-record-editors.ts';
import type { IdentityEditor } from './identity-editor.ts';
import { summarizePetAgent, type AgentChatAvailability } from './pet-agent-overview.ts';
import { ModulePage, OptionRow, Panel } from './WorkspacePanels.tsx';

const sections = [
  { id: 'identity', title: '身份', icon: 'identity' },
  { id: 'memory', title: '记忆', icon: 'memory' },
  { id: 'goals', title: '目标', icon: 'goals' },
  { id: 'capabilities', title: '能力', icon: 'spark' },
] as const;
type Section = typeof sections[number]['id'];
export type CharacterPage = Exclude<Section, 'capabilities'>;
export type AgentMemoryView = { mode: MemoryMode; onMode(mode: MemoryMode): void };
type DialogProps = {
  name: string; reference?: PackageReference; opener?: HTMLElement; onClose(): void;
  renderDetail(page: CharacterPage, memoryView: AgentMemoryView): ReactNode;
};
const missing = () => undefined;
const noSubscription = () => () => {};

/** The caller keys and gates this view by the petID captured when the menu was opened. */
export function PetAgentPanel({ identity, memory, goals, chat, ...dialog }: DialogProps & {
  identity?: IdentityEditor; memory?: MemorySession; goals?: GoalSession; chat: AgentChatAvailability;
}) {
  const i = useSyncExternalStore(identity?.subscribe ?? noSubscription, identity?.getSnapshot ?? missing, identity?.getSnapshot ?? missing);
  const m = useSyncExternalStore(memory?.subscribe ?? noSubscription, memory?.getSnapshot ?? missing, memory?.getSnapshot ?? missing);
  const g = useSyncExternalStore(goals?.subscribe ?? noSubscription, goals?.getSnapshot ?? missing, goals?.getSnapshot ?? missing);
  const invalid = i?.error === 'not-found' || m?.error === 'not-found' || g?.error === 'not-found';
  const { onClose } = dialog;
  useLayoutEffect(() => {
    if (invalid) onClose();
  }, [invalid, onClose]);
  useLayoutEffect(() => {
    // Refresh only through the same read-only, instance-bound ports as the detail pages.
    void identity?.load(); void memory?.load(); void goals?.load();
  }, [identity, memory, goals]);
  return invalid ? null : <AgentDialog {...dialog} overview={summarizePetAgent(i, m, g, chat)} connected={!!identity} />;
}

// Native modal backdrops retarget pointer events to the dialog itself. Empty space
// inside the panel can have that target too, so also check the panel boundary.
const isBackdrop = (event: { target: EventTarget; currentTarget: HTMLDialogElement; clientX: number }) =>
  event.target === event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left;

function AgentDialog({ name, reference, opener, onClose, renderDetail, overview, connected }: DialogProps & {
  overview: ReturnType<typeof summarizePetAgent>; connected: boolean;
}) {
  const [section, setSection] = useState<Section>();
  const [memoryMode, setMemoryMode] = useState<MemoryMode>('personal');
  const panel = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), back = useRef<HTMLButtonElement>(null);
  const backdropPressed = useRef(false);
  const overviewScroll = useRef<HTMLDivElement>(null), overviewPosition = useRef(0), returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const node = panel.current!;
    const chatMain = opener?.closest<HTMLElement>('main');
    node.showModal();
    close.current?.focus();
    return () => {
      node.close();
      // Restore the chat menu, unless navigation/deletion removed it or made it inert.
      queueMicrotask(() => {
        if (node.open || !chatMain?.matches('.content-chat') || !chatMain.isConnected || chatMain.closest('[inert]')) return;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        else if (node.ownerDocument.activeElement === node.ownerDocument.body) chatMain.focus({ preventScroll: true });
      });
    };
  }, [opener]);
  useLayoutEffect(() => {
    if (section) back.current?.focus({ preventScroll: true });
    else if (returnTo.current && overviewScroll.current) {
      overviewScroll.current.scrollTop = overviewPosition.current;
      (returnTo.current.getClientRects().length ? returnTo.current :
        overviewScroll.current.querySelector<HTMLElement>('[data-agent-section="memory"]'))?.focus({ preventScroll: true });
    }
  }, [section]);
  const open = (next: Section, trigger: HTMLElement, mode?: MemoryMode) => {
    overviewPosition.current = overviewScroll.current?.scrollTop ?? 0;
    returnTo.current = trigger;
    if (mode) setMemoryMode(mode);
    setSection(next);
  };
  const title = sections.find(entry => entry.id === section)?.title ?? '';
  const review = overview.pending;
  return <dialog className="pet-agent-panel" data-pet-art={petArt(reference)} ref={panel} aria-labelledby="pet-agent-title"
    onPointerDown={event => { backdropPressed.current = event.isPrimary && event.button === 0 && isBackdrop(event); }}
    onPointerCancel={() => { backdropPressed.current = false; }}
    onPointerUp={event => { backdropPressed.current &&= isBackdrop(event); }}
    onClick={event => {
      const pressed = backdropPressed.current;
      backdropPressed.current = false;
      if (pressed && event.detail > 0 && isBackdrop(event)) onClose();
    }}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="pet-agent-header"><h2 id="pet-agent-title">桌宠 Agent</h2>
      <button type="button" ref={close} className="pet-agent-close" aria-label="关闭" title="关闭" onClick={onClose}>
        <PetNookIcon name="close" />
      </button></header>
    <div className="pet-agent-scroll" ref={overviewScroll} hidden={!!section}>
      <div className="pet-agent-role"><PetCover reference={reference} avatar />
        <div><strong>{name}</strong><span role="status">{overview.privacy}</span></div>
      </div>
      {review && <button type="button" className="pet-agent-review" onClick={event => open('memory', event.currentTarget, review.memoryMode)}>
        <PetNookIcon name="alert" /><span><strong>待你确认</strong><small>{review.count} 条记忆或角色知识</small></span><PetNookIcon name="chevron" />
      </button>}
      <ul className="pet-agent-rows" aria-label="角色总览">
        {sections.map(({ id, title, icon }) => <li key={id}>
          <button type="button" data-agent-section={id} onClick={event => open(id, event.currentTarget)}>
            <span className="pet-agent-icon"><PetNookIcon name={icon} /></span>
            <span><strong>{title}</strong><small>{overview.rows[id]}</small></span><PetNookIcon name="chevron" />
          </button>
        </li>)}
      </ul>
    </div>
    {section && <div className="pet-agent-scroll pet-agent-detail" key={section}>
      <button type="button" ref={back} className="button secondary pet-agent-back" onClick={() => setSection(undefined)}>
        <PetNookIcon name="chevron" />返回总览<span className="sr-only">（当前：{title}）</span>
      </button>
      {section === 'capabilities' ? <ModulePage title="能力" description="查看当前实例可用的功能及资料授权。">
        <Panel title="当前可用">
          {overview.capabilities.includes('本机查询') && <OptionRow title="本机查询" detail="用明确的短句查询身份、个人记忆、角色知识和目标进度。" />}
          {overview.capabilities.includes('在线文字聊天') && <OptionRow title="在线文字聊天" detail="使用聊天中当前可用的已保存模型，发送可能产生费用。" />}
          {!overview.capabilities.length && <p className="module-copy">当前无可用能力。</p>}
        </Panel>
        <Panel title="资料授权"><p className="module-copy" role="status">{overview.privacy}</p>
          <p className="module-copy">只有逐项授权的已保存资料，才可能在相关时用于在线文字聊天。在对应资料详情管理授权。</p>
        </Panel>
      </ModulePage> : connected ? renderDetail(section, { mode: memoryMode, onMode: setMemoryMode }) :
        <ModulePage title={title} description="资料服务未连接。"><p className="module-copy">连接本机工作区后可读取当前实例的资料。</p></ModulePage>}
    </div>}
  </dialog>;
}
