import { useEffect, useRef, useState } from 'react';
import { DialogCloseButton, useDialogDismiss } from './DialogDismiss.tsx';
import { acceptedTaskPrompt, isTaskActive, isTaskResult, type AgentTaskBridge, type AgentTaskCreate, type AgentTaskExecutionPermissionMode, type AgentTaskSnapshot } from '../../../packages/contracts/src/agent-tasks.ts';
import { chatAttachmentLimits, chatTextFileAccept, type ChatAttachment } from '../../../packages/contracts/src/chat-attachments.ts';
import { readAgentTaskFiles } from './chat-attachments.ts';
import { PetNookIcon } from './PetNookIcon.tsx';
import type { ChatModel } from './chat-session.ts';

type Props = { petID: string; name: string; opener?: HTMLElement; models: ChatModel[]; bridge: AgentTaskBridge; onClose(): void };
const statusLabels = { queued: '准备中', running: '执行中', completed: '已完成 · 待审阅', failed: '未完成', cancelled: '已停止等待', 'outcome-unknown': '结果未确认' } as const;
const phaseLabels = { admitting: '校验请求', reading: '读取所选材料', thinking: '等待模型', review: '等待审阅' } as const;
const errors = { unavailable: '暂时无法确认任务状态。请刷新列表，不要直接重复提交。', invalid_request: '任务指令或附件不符合限制。请检查是否含凭证。',
 busy: '任务正在进行，或全局任务已达上限。', not_found: '当前桌宠或任务已不存在。', limit: '本机任务记录已达上限。',
 conflict: '该任务已登记。请刷新列表。', route_changed: '保存的模型已变化，请重新选择。', tools_unavailable: '该模型未能通过工具调用检查。请选择其他模型。',
 provider_failed: '模型未返回有效结果，或超出任务工具读取预算。', timed_out: '等待超时，服务商可能仍在处理已收到的请求。' } as const;

export function taskCreateWasAccepted(input: AgentTaskCreate, reply: unknown): boolean {
 return isTaskResult('create', input, reply) && reply.ok;
}

export function AgentTaskRows({ tasks, busy, onCancel }: { tasks: AgentTaskSnapshot[]; busy: boolean; onCancel(task: AgentTaskSnapshot): void }) {
 return <ul className="agent-task-rows" aria-label="当前桌宠的任务">{tasks.map(task => <li key={task.taskID}>
  <p className="agent-task-id">任务 · {task.taskID.slice(0, 8)}</p>
  <div className="agent-task-status"><strong>{statusLabels[task.status]}</strong>
   {isTaskActive(task.status) && <><span>{phaseLabels[task.phase]}</span><progress max={100} value={task.progress} aria-label="任务进度" />
    <button type="button" className="button secondary" disabled={busy} onClick={() => onCancel(task)}>取消任务</button></>}
  </div>
  {!!task.error && <p>{errors[task.error]}</p>}
  {task.status === 'outcome-unknown' && <p>应用关闭或失联前未确认结果；不会自动继续或重发。</p>}
  {task.status === 'cancelled' && <p>已发出的请求可能仍由服务商处理。</p>}
  {task.result && <details><summary>审阅结果</summary><pre>{task.result}</pre></details>}
 </li>)}</ul>;
}


export function AgentTaskPermissionPicker({ mode, disabled, onChange }: { mode: AgentTaskExecutionPermissionMode; disabled: boolean; onChange(mode: AgentTaskExecutionPermissionMode): void }) {
 const menu = useRef<HTMLDetailsElement>(null);
 const close = (next: AgentTaskExecutionPermissionMode) => { onChange(next); if (menu.current) menu.current.open = false; };
 const full = mode === 'full';
 return <details ref={menu} className="agent-task-permission-picker" onBlur={event => {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
 }}>
  <summary className="agent-task-permission-trigger" aria-label={`执行权限：${full ? '完全允许' : '请求批准'}`}>
   <PetNookIcon name={full ? 'alert' : 'lock'} /><span>{full ? '完全允许' : '请求批准'}</span><PetNookIcon name="down" />
  </summary>
  <div className="agent-task-permission-menu" role="menu" aria-label="执行权限">
   <strong>执行权限</strong>
   <button type="button" role="menuitemradio" aria-checked={!full} disabled={disabled} onClick={() => close('ask')}>
    <span><b>请求批准</b><small>需要额外操作时逐项确认</small></span>{!full && <span aria-hidden="true">✓</span>}
   </button>
   <button type="button" role="menuitemradio" aria-checked={full} disabled={disabled} onClick={() => close('full')}>
    <span><b>完全允许</b><small>仅当前桌宠、模型和任务有效</small></span>{full && <span aria-hidden="true">✓</span>}
   </button>
   <p>当前 Agent 只读取本次明确选择的文本材料，不会修改文件、运行命令或访问外部链接。</p>
  </div>
 </details>;
}

export function FullPermissionDialog({ open, onCancel, onConfirm, returnFocus }: { open: boolean; onCancel(): void; onConfirm(): void; returnFocus?: { current: HTMLElement | null } }) {
 const modal = useRef<HTMLDialogElement>(null);
 const dismiss = useDialogDismiss(onCancel);
 useEffect(() => {
  const dialog = modal.current;
  if (!dialog) return;
  if (open && !dialog.open) dialog.showModal();
  if (!open && dialog.open) { dialog.close(); returnFocus?.current?.focus(); }
 }, [open, returnFocus]);
 return <dialog ref={modal} className="agent-task-permission-dialog" aria-labelledby="agent-task-permission-title" {...dismiss}>
  <header><div><span className="agent-task-permission-kicker">执行权限确认</span><h2 id="agent-task-permission-title">确认使用“完全允许”？</h2></div>
   <DialogCloseButton label="关闭权限确认" onClose={onCancel} />
  </header>
  <p>这项授权只作用于当前桌宠、当前模型和当前任务，不会保存，也不会立即发送任务。</p>
  <p className="agent-task-permission-warning">当前版本仍只允许读取你明确选择的材料，不会获得 Shell、任意文件路径或联网权限。</p>
  <footer><button type="button" className="button secondary" onClick={onCancel}>取消</button><button type="button" className="button destructive" onClick={onConfirm}>确认完全允许</button></footer>
 </dialog>;
}

export function AgentTaskPanel({ petID, name, opener, models, bridge, onClose }: Props) {
 const modal = useRef<HTMLDialogElement>(null);
 const promptField = useRef<HTMLTextAreaElement>(null);
 const dismiss = useDialogDismiss(onClose);
 const alive = useRef(false);
 const fileEpoch = useRef(0);
 const readingFiles = useRef(false);
 const fileInput = useRef<HTMLInputElement>(null);
 const dragDepth = useRef(0);
 const operation = useRef(false);
 const listing = useRef(false);
 const [prompt, setPrompt] = useState('');
 const [model, setModel] = useState('');
 const [permission, setPermission] = useState<AgentTaskExecutionPermissionMode>('ask');
 const [fullPermissionDialog, setFullPermissionDialog] = useState(false);
 const [files, setFiles] = useState<ChatAttachment[]>([]);
 const [tasks, setTasks] = useState<AgentTaskSnapshot[]>([]);
 const [notice, setNotice] = useState('');
 const [fileNotice, setFileNotice] = useState('');
 const [busy, setBusy] = useState(false);
 const [reading, setReading] = useState(false);
 const [dragging, setDragging] = useState(false);
 const [loaded, setLoaded] = useState(false);
 const candidates = models.filter(item => item.ready !== false && item.taskRoute);
 const selectedModel = candidates.find(item => item.id === model);
 const effectivePermission = permission === 'full' ? 'full' : 'ask';
 const modelCapability = selectedModel ? (selectedModel.taskToolsUnverified ? 'unverified' : 'verified') : 'none';
 const route = selectedModel?.taskRoute;
 useEffect(() => {
  if (!model && candidates[0]) setModel(candidates[0].id);
  else if (model && !selectedModel) setModel(candidates[0]?.id ?? '');
 }, [model, selectedModel, candidates]);
 useEffect(() => {
  setPermission('ask');
  setFullPermissionDialog(false);
 }, [model, modelCapability, prompt, files]);
 const filesFull = files.length >= chatAttachmentLimits.maxFiles;
 const resetDrag = () => { dragDepth.current = 0; setDragging(false); };
 const addFiles = async (selection: readonly File[]) => {
  if (!selection.length || !alive.current || document.hidden || operation.current || readingFiles.current) return;
  const epoch = ++fileEpoch.current;
  readingFiles.current = true; setReading(true); setFileNotice('');
  const result = await readAgentTaskFiles(selection, prompt.trim(), files);
  if (!alive.current || epoch !== fileEpoch.current) return;
  readingFiles.current = false; setReading(false);
  if (result.ok) setFiles(result.attachments);
  else setFileNotice({ duplicate: '所选文件与列表中的文件重名，未加入本批材料。', unsupported: '仅支持 UTF-8 文本文件，例如 .txt、.md 和 .csv。',
   limit: '所选文件超过数量或容量限制，未加入本批材料。', invalid: '无法读取所选文本文件，请检查编码和内容大小。' }[result.error]);
 };
 const refresh = async () => {
  if (listing.current || !alive.current || document.hidden) return;
  listing.current = true;
  try {
   const reply = await bridge.list({ petID });
   if (!alive.current) return;
   if (!isTaskResult('list', { petID }, reply) || !reply.ok) { setLoaded(false); return; }
   setTasks(reply.tasks); setLoaded(true);
  } catch { if (alive.current) setLoaded(false); }
  finally { listing.current = false; }
 };
 useEffect(() => {
  const dialog = modal.current;
  alive.current = true;
  dialog?.showModal(); promptField.current?.focus();
  void refresh();
  const timer = setInterval(() => { void refresh(); }, 2000);
  const visibility = () => {
   if (document.hidden) { fileEpoch.current++; readingFiles.current = false; resetDrag(); setFiles([]); setFileNotice(''); setReading(false); }
   else void refresh();
  };
  document.addEventListener('visibilitychange', visibility);
  return () => {
   alive.current = false; fileEpoch.current++; readingFiles.current = false;
   clearInterval(timer); document.removeEventListener('visibilitychange', visibility);
   dialog?.close();
   if (opener?.isConnected) opener.focus();
  };
 }, [bridge, petID, opener]);
 const canStart = loaded && !!route && acceptedTaskPrompt(prompt.trim()) && !!files.length && !reading && !busy && !tasks.some(task => isTaskActive(task.status));
 const start = async () => {
  if (!canStart || !route || operation.current || readingFiles.current || document.hidden) return;
  operation.current = true; setBusy(true); setNotice('');
  const input = { petID, taskID: crypto.randomUUID(), route, prompt: prompt.trim(), files, executionPermission: { mode: effectivePermission } as const };
  try {
   const reply = await bridge.create(input);
   if (!alive.current) return;
   if (!isTaskResult('create', input, reply)) setNotice(errors.unavailable);
   else if (!reply.ok) setNotice(errors[reply.error]);
   else {
    // Keep materials on malformed, failed, or unknown acknowledgements; clear only after verified admission.
    if (taskCreateWasAccepted(input, reply)) setFiles([]);
    setTasks(previous => previous.some(task => task.taskID === reply.task.taskID) ? previous : [reply.task, ...previous]);
    setPrompt('');
   }
  } catch { if (alive.current) setNotice(errors.unavailable); }
  finally { operation.current = false; if (alive.current) { setBusy(false); void refresh(); } }
 };
 const cancel = async ({ taskID }: AgentTaskSnapshot) => {
  if (operation.current || document.hidden) return;
  operation.current = true; setBusy(true); setNotice('');
  try {
   const input = { petID, taskID }, reply = await bridge.cancel(input);
   if (!alive.current) return;
   if (!isTaskResult('cancel', input, reply)) setNotice(errors.unavailable);
   else if (!reply.ok) setNotice(errors[reply.error]);
   else if (isTaskActive(reply.task.status)) setNotice('已请求取消，正在等待任务结束。');
  } catch { if (alive.current) setNotice(errors.unavailable); }
  finally { operation.current = false; if (alive.current) { setBusy(false); void refresh(); } }
 };
 return <><dialog ref={modal} className="chat-clear agent-task-dialog" aria-labelledby="agent-task-title" {...dismiss}>
  <header className="agent-task-header"><div><div className="agent-task-heading"><h2 id="agent-task-title">{name} · Agent 任务</h2><span>只读</span></div>
   <p>开始后，任务指令和所需文件片段将发给所选模型，可能产生费用。不会修改本机文件或角色资料。</p></div>
   <DialogCloseButton onClose={onClose} /></header>
  <div className="agent-task-body">
   <div className="agent-task-composer">
    <label className="agent-task-prompt"><span>任务指令</span><textarea ref={promptField} value={prompt} onChange={event => setPrompt(event.currentTarget.value)} maxLength={12000} rows={3} disabled={busy} placeholder="例如：阅读这两份记录，整理待确认的事项" /></label>
    <div className="agent-task-composer-footer"><AgentTaskPermissionPicker mode={effectivePermission} disabled={busy} onChange={next => {
     if (next === 'full') setFullPermissionDialog(true);
     else setPermission('ask');
    }} /><span className="agent-task-composer-hint">仅当前任务</span>
     <label className="agent-task-model-control"><span>选择模型</span><select value={model} onChange={event => setModel(event.currentTarget.value)} disabled={busy || !candidates.length}>
      <option value="">选择已保存的模型</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.name}{item.taskToolsUnverified ? ' · 待验证' : ''}</option>)}
     </select></label>
     <button className="button primary agent-task-submit" type="button" disabled={!canStart} onClick={() => { void start(); }}>开始任务</button>
    </div>
   </div>
   {!candidates.length && <p className="agent-task-hint">暂无可用模型。请在「模型管理」添加并保存模型，明确不支持工具调用的模型不会显示。</p>}
   {selectedModel?.taskToolsUnverified && <p className="agent-task-hint">开始任务时会先发送一条不含任务指令和文件内容的工具测试；通过后才发送任务内容。</p>}
   <section className="agent-task-materials" aria-labelledby="agent-task-materials-title">
    <div className="agent-task-materials-title"><h3 id="agent-task-materials-title">任务材料</h3><span aria-label={`已选 ${files.length} 个文件`}>{files.length} / {chatAttachmentLimits.maxFiles}</span></div>
    <div className="agent-task-drop-target"
     onDragEnter={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      if (!busy && !readingFiles.current && !filesFull) { dragDepth.current++; setDragging(true); }
     }} onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = busy || readingFiles.current || filesFull ? 'none' : 'copy';
     }} onDragLeave={() => { if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false); }}
     onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); resetDrag();
      if (!busy) void addFiles(Array.from(event.dataTransfer.files));
     }}>
     <input ref={fileInput} type="file" hidden multiple accept={chatTextFileAccept} aria-label="选择任务材料" disabled={busy || reading || filesFull}
      onChange={event => {
       const selection = Array.from(event.currentTarget.files ?? []);
       event.currentTarget.value = '';
       void addFiles(selection);
      }} />
     <button type="button" className="agent-task-dropzone" data-dragging={dragging || undefined} aria-describedby="agent-task-file-limits"
      disabled={busy || reading || filesFull} onClick={() => fileInput.current?.click()}>
      <span className="agent-task-drop-icon"><PetNookIcon name="fileUpload" /></span>
      <strong>{reading ? '正在读取文件…' : filesFull ? '已达到文件上限' : dragging ? '松开以添加文件' : <>拖拽文件到这里，或<span>点击选择</span></>}</strong>
      <small>支持 .txt、.md、.csv 等 UTF-8 文本</small>
     </button>
    </div>
    <p id="agent-task-file-limits" className="agent-task-hint">最多 5 个文件，每个不超过 5 MiB／20,000 字。请勿添加含密钥或敏感内容的文件。</p>
    <p className="agent-task-file-notice" role="status">{fileNotice}</p>
    {files.length > 0 && <ul className="agent-task-file-list" aria-label="任务附件">{files.map(file => <li key={file.name}>
     <PetNookIcon name="fileUpload" /><span title={file.name}>{file.name}</span><button className="agent-task-icon" type="button" disabled={reading || busy}
      aria-label={`移除 ${file.name}`} onClick={() => { setFileNotice(''); setFiles(items => items.filter(item => item.name !== file.name)); }}><PetNookIcon name="close" /></button>
    </li>)}</ul>}
   </section>
   <p className="agent-task-notice" role="status">{notice || (!loaded ? '正在读取或暂时无法读取任务记录。' : '')}</p>
   {tasks.length > 0 && <AgentTaskRows tasks={tasks} busy={busy} onCancel={task => { void cancel(task); }} />}
  </div>
  <footer className="agent-task-actions"><button className="button secondary" type="button" onClick={() => { void refresh(); }}>刷新任务</button></footer>
 </dialog><FullPermissionDialog returnFocus={promptField} open={fullPermissionDialog} onCancel={() => setFullPermissionDialog(false)} onConfirm={() => { setPermission('full'); setFullPermissionDialog(false); }} /></>;
}
