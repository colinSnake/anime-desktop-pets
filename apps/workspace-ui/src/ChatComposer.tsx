import type { VoiceDraftBridge, VoiceDraftError, VoiceDraftResult } from '../../../packages/contracts/src/voice-draft.ts';
import { ChatMicrophoneButton } from './ChatMicrophoneButton.tsx';
import { ChatPermissionPicker } from './ChatPermissionPicker.tsx';
import { CHAT_MEMORY_LIMIT, parseChatMemoryCommand } from '../../../packages/contracts/src/character-records.ts';
import { acceptedChatText } from '../../../packages/contracts/src/online-chat.ts';
import { attachmentModality, chatTextFileAccept } from '../../../packages/contracts/src/chat-attachments.ts';
import { parseLocalChatCommand } from '../../../packages/contracts/src/local-chat.ts';
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { readChatFiles } from './chat-attachments.ts';
import { ChatDraftEditor } from './ChatDraftEditor.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import { ChatModelPicker } from './ChatModelPicker.tsx';
import { ComposerKeyboard } from './chat-input.ts';
import { characterCount, validatedMessage, type ChatWorkspaceController, type ChatWorkspaceState } from './chat-session.ts';

type VoicePhase = 'file' | 'opening' | 'recording' | 'transcribing' | 'permission';
type VoiceOperation = { bridge: VoiceDraftBridge; kind: 'file' | 'microphone' | 'permission'; started?: boolean; stopRequested?: boolean; apply(text: string): boolean };
const voiceNotices: Record<VoiceDraftError, string> = {
 unavailable: '本机语音识别未配置或当前窗口不可用。', busy: '已有语音操作正在清理，请稍后重试。', cancelled: '',
 'invalid-file': '请选择 1–30 秒且不超过 6 MiB 的 PCM WAV 文件。', timeout: '本机读取或转写超时，请重试。',
 'no-speech': '没有识别到可用文字。', failed: '本机语音操作失败，没有发送内容。',
 'too-short': '请按住说话至少 1 秒。', 'permission-required': '首次使用需先授权麦克风，授权不会开始录音。',
 'permission-denied': '麦克风不可用。可在系统设置 → 隐私与安全性 → 麦克风中检查权限。',
};

const DraftPreview = lazy(() => import('./routes/chat-draft-preview.ts'));

export function resetComposerDragState(fileRead: { current: number }, dragDepth: { current: number }): void {
 fileRead.current++;
 dragDepth.current = 0;
}

export function ChatComposer({ state, controller, name, input, voiceDraft }: {
 state: ChatWorkspaceState; controller?: ChatWorkspaceController; name: string; input: RefObject<HTMLDivElement | null>; voiceDraft?: VoiceDraftBridge;
}) {
 const keyboard = useRef(new ComposerKeyboard());
 const [composing, setComposing] = useState(false);
 const [editorIssue, setEditorIssue] = useState<'limit' | 'broken' | ''>('');
 const [previewing, setPreviewing] = useState(false);
 const [reading, setReading] = useState(false);
 const [fileNotice, setFileNotice] = useState('');
 const [voicePhase, setVoicePhase] = useState<VoicePhase>();
 const voiceBusy = !!voicePhase;
 const [voiceNotice, setVoiceNotice] = useState('');
 const [voiceError, setVoiceError] = useState<VoiceDraftError>();
 const voiceOperation = useRef<VoiceOperation | undefined>(undefined);
 const cancelVoice = useCallback(() => {
  const running = voiceOperation.current;
  voiceOperation.current = undefined;
  if (running?.kind === 'file') void running.bridge.cancel().catch(() => {});
  if (running?.kind === 'microphone') running.bridge.microphone.cancel();
 }, []);
 useEffect(() => {
  setVoicePhase(undefined); setVoiceNotice(''); setVoiceError(undefined);
  const hideVoice = () => { if (document.hidden) { cancelVoice(); setVoicePhase(undefined); setVoiceNotice(''); setVoiceError(undefined); } };
  const blur = () => {
   if (voiceOperation.current?.kind !== 'microphone') return;
   cancelVoice(); setVoicePhase(undefined); setVoiceNotice('窗口失焦，已取消本机语音操作。');
  };
  document.addEventListener('visibilitychange', hideVoice);
  window.addEventListener('blur', blur);
  return () => { cancelVoice(); document.removeEventListener('visibilitychange', hideVoice); window.removeEventListener('blur', blur); };
 }, [cancelVoice, voiceDraft, state.selectedId, state.session.editorKey]);
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
 const canSend = !!controller && !!state.selectedId && !session.pending && !session.awaitingApproval && !composing && !previewing && editorIssue !== 'broken' && !!validatedMessage(text) &&
  !reading && !attachmentIssue && (memory ? !memoryInvalid && !!state.memoryAvailable : intent ? local && state.localAvailable : state.available && !!session.model && !invalidOnlineText);
 const canAddFiles = !!state.materialApproval && !!controller && state.available && !session.pending && !memory && !intent;
 const voiceEligible = !!controller && !!state.selectedId && !session.draft && !session.attachments.length &&
  !session.pending && !session.awaitingApproval && !reading && !previewing && !composing;
 const beginVoice = (kind: VoiceOperation['kind'], phase: VoicePhase) => {
  const petID = state.selectedId;
  if (!petID || !voiceDraft || !controller || !voiceEligible || voiceOperation.current) return;
  const running: VoiceOperation = { bridge: voiceDraft, kind,
   apply: text => controller.importVoiceDraft(petID, session.editorKey, session.draftSnapshot, text) };
  voiceOperation.current = running;
  setVoicePhase(phase); setVoiceNotice(''); setVoiceError(undefined);
  return running;
 };
 const clearVoice = (running: VoiceOperation) => {
  if (voiceOperation.current !== running) return false;
  voiceOperation.current = undefined; setVoicePhase(undefined); return true;
 };
 const reportVoice = (running: VoiceOperation, response: VoiceDraftResult) => {
  if (!clearVoice(running)) return;
  if (!response.ok) { setVoiceNotice(voiceNotices[response.error]); setVoiceError(response.error); return; }
  if (!running.apply(response.text)) { setVoiceNotice('草稿已变化，未覆盖当前内容。'); return; }
  setVoiceNotice('转写已填入草稿，确认后可手动发送。');
  input.current?.focus({ preventScroll: true });
 };
 const failedVoice = () => ({ ok: false, error: 'failed' } as const);
 const startVoice = async () => {
  const running = beginVoice('file', 'file');
  if (running) reportVoice(running, await running.bridge.select().catch(failedVoice));
 };
 const authorizeVoice = async () => {
  const running = beginVoice('permission', 'permission');
  if (!running) return;
  const result = await running.bridge.microphone.authorize().catch(failedVoice);
  if (!result.ok) { reportVoice(running, result); return; }
  if (clearVoice(running)) setVoiceNotice('麦克风已授权。再次按住说话才会开始录音。');
 };
 const startMic = async () => {
  const running = beginVoice('microphone', 'opening');
  if (!running) return;
  const result = await running.bridge.microphone.start(() => {
   if (clearVoice(running)) setVoiceNotice('录音已中断或达到时限，没有发送内容。');
  }).catch(failedVoice);
  if (!result.ok) {
   reportVoice(running, result.error === 'cancelled' && running.stopRequested ? { ok: false, error: 'too-short' } : result);
   return;
  }
  running.started = true;
  if (voiceOperation.current === running) setVoicePhase(previous => previous === 'opening' ? 'recording' : previous);
 };
 const stopMic = async () => {
  const running = voiceOperation.current;
  if (running?.kind !== 'microphone' || running.stopRequested) return;
  running.stopRequested = true;
  setVoicePhase('transcribing');
  const result = await running.bridge.microphone.stop().catch(failedVoice);
  // When released before opening completes, start reports the permission or short-press result.
  if (result.ok || result.error !== 'cancelled' || running.started) reportVoice(running, result);
 };
 const cancelMic = () => {
  if (voiceOperation.current?.kind !== 'microphone') return;
  cancelVoice(); setVoicePhase(undefined); setVoiceNotice('已取消本机语音操作。');
 };
 const micActive = voicePhase === 'opening' || voicePhase === 'recording';
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
 } as const : state.available || pendingRoute ? (state.online ? undefined
  : { label: '文字聊天', icon: 'chat', description: '为当前角色发送消息。' } as const) : {
  label: state.models.length ? '模型不可用' : state.online ? '未配置模型' : '模型服务未连接', icon: 'models',
  description: state.models.length ? '请选择可用模型，或在「模型管理」中检查连接。' : state.online ? (state.localAvailable ? '仍可查询本机资料；在线发送需先在「模型管理」配置模型。' : '在线发送需先在「模型管理」配置模型。') : '模型服务尚未接入，草稿会保留。',
 } as const;
 const descriptionIDs = [route && 'chat-delivery', invalidOnlineText && 'chat-text-boundary', count > 1000 && 'chat-character-count'].filter(Boolean).join(' ');
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
  if (state.selectedId && current?.selectedId === state.selectedId && current.session.editorKey === session.editorKey) {
   cancelVoice(); setVoicePhase(undefined); setVoiceNotice(''); setVoiceError(undefined);
   void controller?.send();
  }
 };
 const sendLabel = memory ? '生成本机记忆提案' : intent && state.localAvailable ? '查询本机资料' : '发送消息';
 const send = () => {
  if (keyboard.current.action({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13 }, canSend, performance.now()) === 'send') submitCurrent();
  input.current?.focus();
 };
 return <>
 {route && <div className="chat-delivery" id="chat-delivery" role="status">
  <strong><PetNookIcon name={route.icon} />{route.label}</strong><span>{route.description}</span>
 </div>}
 <div className="chat-composer" data-dragging={dragging || undefined} aria-label="消息输入区"
  onKeyDown={event => { if (event.key === 'Escape' && voiceOperation.current?.kind === 'microphone') { event.preventDefault(); cancelMic(); } }}
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
   invalid={count > 1200 || invalidOnlineText || localError || memoryInvalid} describedBy={descriptionIDs || undefined}
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
 {session.attachments.length > 0 && <div className="chat-attachments"><span>仅本轮 · 批准后由所选模型处理</span>
  <ul aria-label="本轮附件">{session.attachments.map(file => <li key={file.name}><span title={file.name}>{file.name}</span>
   <button type="button" aria-label={`移除 ${file.name}`} disabled={reading} onClick={() => state.selectedId && controller?.removeAttachment(state.selectedId, session.editorKey, file.name)}>×</button></li>)}</ul></div>}
 {(voiceBusy || voiceNotice) && <div className="chat-voice-progress chat-status">
  <span role="status">{voicePhase ? {
   file: '选择或转写语音中，仅在本机处理…', opening: '正在打开麦克风…', recording: '正在录音，松开后转写（最多 30 秒）…',
   transcribing: '正在本机转写…', permission: '等待系统麦克风授权…',
  }[voicePhase] : voiceNotice}</span>
  {voiceError === 'permission-required' && voiceEligible && <button type="button" data-microphone-action="authorize" onClick={() => { void authorizeVoice(); }}>授权麦克风</button>}
  {voiceBusy && voicePhase !== 'permission' && <button type="button" onClick={() => {
   cancelVoice(); setVoicePhase(undefined); setVoiceNotice('已取消本机语音操作。'); input.current?.focus();
  }}>取消语音</button>}
 </div>}
 {(reading || fileNotice || attachmentIssue) && <p className="chat-status" role="status">{reading ? '正在检查附件…' : attachmentIssue || fileNotice}</p>}
 {(invalidOnlineText || count > 1000) && <div className="chat-composer-limits">
  {invalidOnlineText && <span id="chat-text-boundary" className="chat-counter error" aria-live="polite">超出字节上限或含不支持的字符</span>}
  {count > 1000 && <span id="chat-character-count" className={count > 1200 ? 'chat-counter error' : 'chat-counter'} aria-live="polite">{count}/1200</span>}
 </div>}
  <div className="chat-composer-footer">
   <ChatContentOptions onVoice={voiceDraft ? () => { void startVoice(); } : undefined}
    canUseVoice={voiceEligible && !voiceBusy} previewing={previewing} canPreview={!!text && !composing && editorIssue !== 'broken'} onFiles={canAddFiles && !reading ? () => fileInput.current?.click() : undefined} onToggle={() => {
    setPreviewing(!previewing);
    if (previewing) requestAnimationFrame(() => input.current?.focus());
   }} />
   {voiceDraft && <ChatMicrophoneButton enabled={voiceEligible && !voiceBusy} active={micActive}
    start={() => { void startMic(); }} stop={() => { void stopMic(); }} cancel={cancelMic} />}
   <ChatPermissionPicker name={name} session={session} controller={controller} />
   <div className="chat-composer-actions">
    <span className="chat-composer-ring" aria-hidden="true" />
    <ChatModelPicker state={state} controller={controller} />
    {session.pending ? <button type="button" className="chat-send chat-send-stop" aria-label="停止等待回复" title="停止等待当前回复" onClick={() => controller?.cancel()}><PetNookIcon name="stop" /></button> :
     <button type="button" className="chat-send" disabled={!canSend} aria-label={sendLabel} title={sendLabel} onClick={send}><PetNookIcon name="send" /></button>}
   </div>
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

function ChatContentOptions({ previewing, canPreview, onToggle, onFiles, onVoice, canUseVoice }: { previewing: boolean; canPreview: boolean; onToggle(): void; onFiles?(): void; onVoice?(): void; canUseVoice: boolean }) {
 const menu = useRef<HTMLDetailsElement>(null);
 const focusToggle = () => menu.current?.querySelector('summary')?.focus();
 return <details className="chat-content-options" ref={menu} onBlur={event => {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
 }} onKeyDown={event => {
  if (event.key === 'Escape' && event.currentTarget.open) {
   event.preventDefault(); event.currentTarget.open = false; focusToggle();
  }
 }}>
  <summary className="chat-add" aria-label="添加内容" title="添加内容"><PetNookIcon name="plus" /></summary>
  <div className="chat-content-popover">{onFiles && <button type="button" onClick={() => { onFiles(); if (menu.current) menu.current.open = false; focusToggle(); }}>
   选择或替换附件</button>}{onVoice && <button type="button" disabled={!canUseVoice} title={canUseVoice ? undefined : '请在未发送内容的空白输入框中使用'} onClick={() => { if (menu.current) menu.current.open = false; focusToggle(); onVoice(); }}>
   语音转文字（本机）</button>}<button type="button" disabled={!previewing && !canPreview} onClick={() => {
   if (menu.current) menu.current.open = false;
   focusToggle(); onToggle();
  }}>{previewing ? '继续编辑' : '预览 Markdown'}</button></div>
 </details>;
}
