import { CHAT_MEMORY_LIMIT, parseChatMemoryCommand } from '../../../packages/contracts/src/character-records.ts';
import { DialogCloseButton } from './DialogDismiss.tsx';
import { acceptedChatText } from '../../../packages/contracts/src/online-chat.ts';
import { attachmentModality, chatTextFileAccept } from '../../../packages/contracts/src/chat-attachments.ts';
import { parseLocalChatCommand } from '../../../packages/contracts/src/local-chat.ts';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { readChatFiles } from './chat-attachments.ts';
import { ChatDraftEditor } from './ChatDraftEditor.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import { ComposerKeyboard } from './chat-input.ts';
import { characterCount, validatedMessage, type ChatWorkspaceController, type ChatWorkspaceState } from './chat-session.ts';

const DraftPreview = lazy(() => import('./routes/chat-draft-preview.ts'));

export function resetComposerDragState(fileRead: { current: number }, dragDepth: { current: number }): void {
 fileRead.current++;
 dragDepth.current = 0;
}

export function ChatComposer({ state, controller, name, input }: { state: ChatWorkspaceState; controller?: ChatWorkspaceController; name: string; input: RefObject<HTMLDivElement | null> }) {
 const keyboard = useRef(new ComposerKeyboard());
 const [composing, setComposing] = useState(false);
 const [editorIssue, setEditorIssue] = useState<'limit' | 'broken' | ''>('');
 const [previewing, setPreviewing] = useState(false);
 const [reading, setReading] = useState(false);
 const [fileNotice, setFileNotice] = useState('');
 const fileInput = useRef<HTMLInputElement>(null);
 const fileRead = useRef(0);
 const dragDepth = useRef(0);
 const [dragging, setDragging] = useState(false);
 useEffect(() => {
  const hide = () => { if (document.hidden) { resetComposerDragState(fileRead, dragDepth); setReading(false); setFileNotice(''); setDragging(false); controller?.cancel(); } };
  document.addEventListener('visibilitychange', hide);
  return () => { fileRead.current++; document.removeEventListener('visibilitychange', hide); };
 }, [controller]);
 const { session } = state;
 const text = session.draft.trim();
 const count = characterCount(text);
 const memory = parseChatMemoryCommand(session.draft);
 const memoryInvalid = typeof memory === 'string';
 const intent = parseLocalChatCommand(session.draft);
 const invalidOnlineText = !!state.online && !memory && !intent && !!text && count <= 1200 && !acceptedChatText(text);
 const local = !!intent && intent !== 'invalid';
 const modalities = state.models.find(model => model.id === session.model)?.inputModalities ?? [];
 const incompatible = session.attachments.some(file => {
  const modality = attachmentModality(file);
  return modality && !modalities.includes(modality);
 });
 const attachmentIssue = session.attachments.length && (memory || intent) ? '本机指令不能携带附件。请先移除附件。'
  : incompatible ? '当前模型不支持所选图片或 PDF。请切换模型或移除附件。' : '';
 const canSend = !!controller && !!state.selectedId && !session.pending && !composing && !previewing && editorIssue !== 'broken' && !!validatedMessage(text) &&
  !reading && !attachmentIssue && (memory ? !memoryInvalid && !!state.memoryAvailable : intent ? local && state.localAvailable : state.available && !!session.model && !invalidOnlineText);
 const canAddFiles = !!state.online && !!controller && state.available && !session.pending && !memory && !intent;
 const pendingRoute = session.pending && !text;
 const delivery = (pendingRoute ? session.turns.at(-1)?.localOnly : intent) ? 'local' : 'model';
 const localError = intent === 'invalid';
 const route = memory ? {
  label: '本机记忆 · 不发送到模型', icon: 'lock',
  description: memory === 'credential-like' ? '内容可能含凭证，不能保存为记忆。' : memoryInvalid ? `请在「记住：」后填写不超过 ${CHAT_MEMORY_LIMIT} 字的单行内容。` :
   !state.memoryAvailable ? '本机记忆暂不可用，草稿会保留。' : '先生成提案，确认后才保存到当前桌宠。',
 } as const : delivery === 'local' ? {
  label: '本机查询', icon: 'lock',
  description: !state.localAvailable ? '本机查询暂不可用，此命令不会转发给模型。' : localError ? '请输入查询关键词。本机指令不会发送给模型服务。' : '只查当前角色的本机资料，不发送给模型服务。',
 } as const : state.available || pendingRoute ? (state.online ? {
  label: '在线文字', icon: 'globe', description: state.persistentConversations ? '消息、当前会话近期可回放的普通问答及本轮已授权资料会发给所选模型，可能产生费用。'
   : '消息、同一连接和模型可用的聊天记录及已授权资料会发给所选服务，可能产生费用。',
 } as const : { label: '文字聊天', icon: 'chat', description: '为当前角色发送消息。' } as const) : {
  label: state.models.length ? '模型不可用' : state.online ? '未配置模型' : '模型服务未连接', icon: 'models',
  description: state.models.length ? '请选择可用模型，或在「模型管理」中检查连接。' : state.online ? (state.localAvailable ? '仍可查询本机资料；在线发送需先在「模型管理」配置模型。' : '在线发送需先在「模型管理」配置模型。') : '模型服务尚未接入，草稿会保留。',
 } as const;
 const resetDrag = () => { dragDepth.current = 0; setDragging(false); };
 const readSelection = async (files: readonly File[]) => {
  if (!files.length || !state.selectedId || !controller || !canAddFiles || reading) return;
  const serial = ++fileRead.current;
  setReading(true); setFileNotice('');
  const result = await readChatFiles(files, session.draft);
  if (serial !== fileRead.current) return;
  setReading(false);
  if (!result.ok) setFileNotice(result.error === 'limit' ? '最多 5 个附件，单个 5 MiB，合计 15 MiB。' : '文件类型或内容不符合附件限制。');
  else controller.setAttachments(state.selectedId, result.attachments, session.editorKey);
 };
 const submitCurrent = () => {
  const current = controller?.getSnapshot();
  if (state.selectedId && current?.selectedId === state.selectedId && current.session.editorKey === session.editorKey) void controller?.send();
 };
 const send = () => {
  if (keyboard.current.action({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13 }, canSend, performance.now()) === 'send') submitCurrent();
  input.current?.focus();
 };
 return <>
 <div className="chat-delivery" id="chat-delivery" role="status">
  <strong><PetNookIcon name={route.icon} />{route.label}</strong><span>{route.description}</span>
 </div>
 <div className="chat-composer" data-dragging={dragging || undefined} aria-label="消息输入区"
  onDragEnter={event => {
   if (!event.dataTransfer.types.includes('Files')) return;
   event.preventDefault();
   if (canAddFiles && !reading) { dragDepth.current++; setDragging(true); }
  }} onDragOver={event => {
   if (!event.dataTransfer.types.includes('Files')) return;
   event.preventDefault(); event.dataTransfer.dropEffect = canAddFiles && !reading ? 'copy' : 'none';
  }} onDragLeave={() => { if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false); }}
  onDrop={event => {
   if (!event.dataTransfer.types.includes('Files')) return;
   event.preventDefault(); resetDrag();
   if (canAddFiles && !reading) void readSelection(Array.from(event.dataTransfer.files));
  }}>
  <div className="chat-composer-editor" hidden={previewing}><ChatDraftEditor hidden={previewing} input={input} draft={session.draftSnapshot} editable={!!controller && !!state.selectedId} placeholder={`和${name}聊聊……`}
   invalid={count > 1200 || invalidOnlineText || localError || memoryInvalid} describedBy={`chat-delivery${invalidOnlineText ? ' chat-text-boundary' : ''}${count > 1000 ? ' chat-character-count' : ''}`}
   onDraft={value => !!state.selectedId && !!controller?.editDraft(state.selectedId, value, session.editorKey)} onTrouble={setEditorIssue}
   onCompose={active => { if (active) keyboard.current.start(); else keyboard.current.end(performance.now()); setComposing(active); }}
   onKeyDown={event => {
    const action = keyboard.current.action({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode, repeat: event.repeat }, canSend, performance.now());
    if (action === 'native') return;
    event.preventDefault(); event.stopPropagation();
    if (action === 'blur') event.currentTarget.blur();
    if (action === 'send') submitCurrent();
   }} /></div>
  {dragging && <div className="chat-drop-hint" role="status"><PetNookIcon name="fileUpload" />松开以添加附件</div>}
  {previewing && <DraftPreviewBoundary><Suspense fallback={<p className="chat-status" role="status">正在加载 Markdown 预览…</p>}><DraftPreview text={session.draft} /></Suspense></DraftPreviewBoundary>}
  {editorIssue && <p className="chat-status" role="status">{editorIssue === 'limit' ? '草稿已达编辑上限，未加入多余内容。' : '编辑器不可用，草稿仍保留。可离开聊天后重试。'}</p>}
 {state.online && <input ref={fileInput} type="file" hidden multiple disabled={!canAddFiles || reading} aria-label="选择本轮附件"
  accept={[chatTextFileAccept, ...(modalities.includes('image') ? ['image/png,image/jpeg,image/webp'] : []), ...(modalities.includes('pdf') ? ['application/pdf'] : [])].join(',')}
  onChange={event => {
   const files = Array.from(event.currentTarget.files ?? []);
   event.currentTarget.value = '';
   void readSelection(files);
  }} />}
 {session.attachments.length > 0 && <div className="chat-attachments"><span>仅本轮 · 发送给所选模型</span>
  <ul aria-label="本轮附件">{session.attachments.map(file => <li key={file.name}><span title={file.name}>{file.name}</span>
   <button type="button" aria-label={`移除 ${file.name}`} disabled={reading} onClick={() => state.selectedId && controller?.removeAttachment(state.selectedId, session.editorKey, file.name)}>×</button></li>)}</ul></div>}
 {(reading || fileNotice || attachmentIssue) && <p className="chat-status" role="status">{reading ? '正在检查附件…' : attachmentIssue || fileNotice}</p>}
  <div className="chat-composer-actions chat-composer-footer">
   <ChatContentOptions previewing={previewing} canPreview={!!text && !composing && editorIssue !== 'broken'} onFiles={canAddFiles && !reading ? () => fileInput.current?.click() : undefined} onToggle={() => {
    setPreviewing(!previewing);
    if (previewing) requestAnimationFrame(() => input.current?.focus());
   }} />
   <span className="chat-input-keys">{memory ? 'Enter 提议' : intent ? 'Enter 查询' : 'Enter 发送'}<span> · Shift + Enter 换行</span></span>
   {invalidOnlineText && <span id="chat-text-boundary" className="chat-counter error" aria-live="polite">超出字节上限或含不支持的字符</span>}
   {count > 1000 && <span id="chat-character-count" className={count > 1200 ? 'chat-counter error' : 'chat-counter'} aria-live="polite">{count}/1200</span>}
   <ChatModelPicker state={state} controller={controller} />
   {session.pending ? <button type="button" className="chat-send" aria-label="停止等待回复" title="停止等待当前回复" onClick={() => controller?.cancel()}><PetNookIcon name="stop" /></button> :
    <button type="button" className="chat-send" disabled={!canSend} aria-label={memory ? '生成本机记忆提案' : intent && state.localAvailable ? '查询本机资料' : '发送消息'} title={memory ? 'Enter 生成本机记忆提案' : intent ? 'Enter 查询本机资料' : 'Enter 发送，Shift+Enter 换行'} onClick={send}><PetNookIcon name="send" /></button>}
  </div>
 </div></>;
}

class DraftPreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
 state = { failed: false };
 static getDerivedStateFromError() { return { failed: true }; }
 render() {
  return this.state.failed ? <p role="status" className="chat-status">预览暂不可用，可以继续编辑。</p> : this.props.children;
 }
}

function ChatContentOptions({ previewing, canPreview, onToggle, onFiles }: { previewing: boolean; canPreview: boolean; onToggle(): void; onFiles?(): void }) {
 const menu = useRef<HTMLDetailsElement>(null);
 const focusToggle = () => menu.current?.querySelector('summary')?.focus();
 return <details className="chat-content-options" ref={menu} onBlur={event => {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
 }} onKeyDown={event => {
  if (event.key === 'Escape' && event.currentTarget.open) {
   event.preventDefault(); event.currentTarget.open = false; focusToggle();
  }
 }}>
  <summary className="chat-control" aria-label="添加内容" title="内容选项"><PetNookIcon name="plus" /></summary>
  <div className="chat-content-popover">{onFiles && <button type="button" onClick={() => { onFiles(); if (menu.current) menu.current.open = false; focusToggle(); }}>
   选择或替换附件</button>}<button type="button" disabled={!previewing && !canPreview} onClick={() => {
   if (menu.current) menu.current.open = false;
   focusToggle(); onToggle();
  }}>{previewing ? '继续编辑' : '预览 Markdown'}</button></div>
 </details>;
}

function ChatModelPicker({state, controller}:{state:ChatWorkspaceState;controller?:ChatWorkspaceController}) {
 const [open, setOpen] = useState(false);
 const picker = useRef<HTMLDivElement>(null);
 const toggle = useRef<HTMLButtonElement>(null);
 const selected = state.models.find(model => model.id === state.session.model);
 const enabled = !!controller && state.models.length > 0 && !state.session.pending;
 const dismiss = () => { setOpen(false); toggle.current?.focus(); };
 useEffect(() => {
  if (!open || !enabled) return;
  const outside = (event: MouseEvent) => {
   if (event.target instanceof Node && !picker.current?.contains(event.target)) setOpen(false);
  };
  document.addEventListener('click', outside, true);
  return () => document.removeEventListener('click', outside, true);
 }, [open, enabled]);
 return <div className="chat-model-picker" ref={picker} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={event => {
  if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(); }
 }}>
  <button type="button" className="chat-model-toggle" ref={toggle} disabled={!enabled} aria-haspopup="dialog" aria-expanded={open && enabled} onClick={() => setOpen(!open)} title="仅影响后续文字聊天，不更改全局默认模型"><PetNookIcon name="models" /><span>{selected?.name ?? (state.models.length ? '选择模型' : '未配置模型')}</span><PetNookIcon name="down" /></button>
  {open && enabled && <div className="chat-model-list" role="dialog" aria-label="选择模型"><header className="dialog-title-row"><h2>选择模型</h2><DialogCloseButton label="关闭模型选择" onClose={dismiss} /></header><div role="group" aria-label="已保存模型">{state.online && state.models.some(model => model.isDefault) && <button type="button" onClick={() => { controller?.selectModel(''); dismiss(); }}>使用全局默认</button>}{state.models.map(model => <button type="button" key={model.id} disabled={model.ready === false} aria-pressed={model.id === state.session.model} onClick={() => { controller?.selectModel(model.id); dismiss(); }}>{model.name}{model.id === state.session.model && <span aria-hidden="true">✓</span>}</button>)}</div></div>}
 </div>;
}
