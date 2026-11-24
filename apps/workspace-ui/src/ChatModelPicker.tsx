import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { defaultReasoningEffort, reasoningLabels, type ReasoningEffort } from '../../../packages/contracts/src/model-capabilities.ts';
import type { ChatModel, ChatWorkspaceController, ChatWorkspaceState } from './chat-session.ts';
import { PetNookIcon } from './PetNookIcon.tsx';

type ModelMenuProps = { models: ChatModel[]; selectedId?: string; online?: boolean; onChoose: (id: string) => void };
type ModelGroup = { provider: string; models: ChatModel[] };
function modelLabel(model: ChatModel, online?: boolean) {
  if (model.modelName !== undefined || !online) return model.modelName ?? model.name;
  const separator = model.name.lastIndexOf(' · ');
  return separator < 0 ? model.name : model.name.slice(0, separator);
}
function modelProvider(model: ChatModel, online?: boolean) {
  if (model.providerName) return model.providerName;
  if (online) {
    const separator = model.name.lastIndexOf(' · ');
    if (separator >= 0) return model.name.slice(separator + 3);
  }
  return '';
}

export function ChatModelMenu({ models, selectedId, online, onChoose }: ModelMenuProps) {
  const groups: ModelGroup[] = [];
  for (const model of models) {
    const provider = modelProvider(model, online);
    let group = groups.find(item => item.provider === provider);
    if (!group) { group = { provider, models: [] }; groups.push(group); }
    group.models.push(model);
  }
  return <div className="chat-model-list" role="dialog" aria-label="选择模型">
    <h2>选择模型</h2>
    <div className="chat-model-groups">
      {groups.map((group, index) => <div className="chat-model-group" role="group" aria-label={group.provider || '模型'} key={`${group.provider}-${index}`}>
        {group.provider && <h3>{group.provider}</h3>}
        {group.models.map(model => <button type="button" key={model.id} disabled={model.ready === false}
          aria-pressed={model.id === selectedId} onClick={() => onChoose(model.id)}>
          <span>{modelLabel(model, online)}</span>{model.id === selectedId && <span className="chat-model-check" aria-label="当前模型">✓</span>}
        </button>)}
      </div>)}
    </div>
  </div>;
}

export function ThinkingDepthSlider({ level, levels, onChange, children }: {
  level: ReasoningEffort; levels: readonly ReasoningEffort[]; onChange: (level: ReasoningEffort) => void; children?: ReactNode;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const rail = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const pointer = useRef<{ id: number; offset: number; x: number; frame: number | null } | null>(null);
  const max = Math.max(0, levels.length - 1);
  const selected = Math.max(0, levels.indexOf(level));
  const position = max ? (draft ?? selected / max) : 0;
  const index = max ? Math.round(position * max) : 0;
  const label = reasoningLabels[levels[index] ?? level];
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const cancelFrame = () => { if (pointer.current?.frame !== null && pointer.current?.frame !== undefined) cancelAnimationFrame(pointer.current.frame); };
  const positionAt = (clientX: number, offset: number) => {
    const bounds = rail.current?.getBoundingClientRect();
    return bounds?.width ? clamp((clientX - bounds.left - offset) / bounds.width) : position;
  };
  const commit = (next: number) => { const candidate = levels[Math.max(0, Math.min(max, next))]; if (candidate && candidate !== level) onChange(candidate); };
  useEffect(() => () => { cancelFrame(); pointer.current = null; }, []);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (active?.id !== event.pointerId) return;
    cancelFrame(); pointer.current = null; setDraft(null);
    if (event.type === 'pointerup') commit(Math.round(positionAt(event.clientX, active.offset) * max));
  };
  return <>
    <div className="chat-thinking-summary">
      <div className="chat-thinking-heading" aria-live="polite">{label}</div>
      {children}
    </div>
    <div className="chat-thinking-slider" role="slider" aria-label="思考深度" tabIndex={0}
      aria-valuemin={0} aria-valuemax={max} aria-valuenow={index} aria-valuetext={label}
      data-dragging={draft !== null || undefined} style={{ '--reasoning-position': position } as CSSProperties}
      onPointerDown={event => {
        if (max < 1 || pointer.current || event.button !== 0 || !event.isPrimary) return;
        const bounds = thumb.current?.getBoundingClientRect();
        const offset = event.target === thumb.current && bounds ? event.clientX - bounds.left - bounds.width / 2 : 0;
        pointer.current = { id: event.pointerId, offset, x: event.clientX, frame: null };
        event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true });
        setDraft(positionAt(event.clientX, offset));
      }}
      onPointerMove={event => {
        const active = pointer.current;
        if (active?.id !== event.pointerId) return;
        active.x = event.clientX;
        if (active.frame === null) active.frame = requestAnimationFrame(() => {
          if (!pointer.current) return;
          pointer.current.frame = null; setDraft(positionAt(active.x, active.offset));
        });
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? max
          : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? selected + 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? selected - 1 : null;
        if (next === null) return;
        event.preventDefault(); if (!pointer.current) commit(next);
      }}>
      <span className="chat-thinking-track" aria-hidden="true"><span className="chat-thinking-bar" /></span>
      <span ref={rail} className="chat-thinking-rail" aria-hidden="true"><span className="chat-thinking-marker" />
        <span ref={thumb} className="chat-thinking-thumb" />
      </span>
    </div>
  </>;
}

export function ChatModelPicker({ state, controller }: { state: ChatWorkspaceState; controller?: ChatWorkspaceController }) {
  const [panel, setPanel] = useState<'thinking' | 'models' | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = state.models.find(model => model.id === state.session.model);
  const selectedName = selected ? modelLabel(selected, state.online) : undefined;
  const enabled = !!controller && state.models.length > 0 && !state.session.pending;
  const levels = selected?.reasoningLevels ?? [];
  const canThink = levels.length > 1 && state.session.reasoningEffort !== undefined;
  const dismiss = (restoreFocus = true) => { setPanel(null); if (restoreFocus) toggle.current?.focus(); };
  const showModels = () => setPanel('models');
  useEffect(() => {
    if (!panel || !enabled) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setPanel(null);
    };
    document.addEventListener('click', outside, true);
    return () => document.removeEventListener('click', outside, true);
  }, [panel, enabled]);
  useEffect(() => {
    if (panel === 'thinking') {
      picker.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
      return;
    }
    if (panel !== 'models') return;
    const current = menu.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)');
    const first = current ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });
  }, [panel]);
  const onChoose = (id: string) => { controller?.selectModel(id); dismiss(); };
  return <div className="chat-model-picker" ref={picker} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPanel(null);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && panel) { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
    if (event.key === 'Tab' && panel === 'thinking') {
      const controls = picker.current?.querySelectorAll<HTMLElement>('.chat-thinking-model, [role="slider"]');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <button type="button" className="chat-model-toggle" ref={toggle} disabled={!enabled}
      aria-haspopup="dialog" aria-expanded={panel !== null && enabled} onClick={() => {
        if (!canThink) setPanel(panel === 'models' ? null : 'models');
        else setPanel(panel === null ? 'thinking' : panel === 'thinking' ? null : 'thinking');
      }} title={selectedName ?? '选择聊天模型'} aria-label={selectedName ? `切换聊天模型：${selectedName}` : undefined}>
      <span>{selectedName ?? (state.models.length ? '选择模型' : '未配置模型')}</span><PetNookIcon name="down" />
    </button>
    {panel === 'thinking' && enabled && canThink && selected && <div className="chat-thinking-popover" role="dialog" aria-label="思考深度">
      <ThinkingDepthSlider level={state.session.reasoningEffort ?? selected.reasoningEffort ?? defaultReasoningEffort(levels)!}
        levels={levels} onChange={effort => controller?.selectReasoning(effort)}>
        <button type="button" className="chat-thinking-model" aria-label={`切换模型：${selectedName}`} onClick={showModels}>
          <span>{selectedName}</span><PetNookIcon name="chevron" />
        </button>
      </ThinkingDepthSlider>
    </div>}
    {panel === 'models' && enabled && <div ref={menu}><ChatModelMenu models={state.models} selectedId={state.session.model} online={state.online} onChoose={onChoose} /></div>}
  </div>;
}
