import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useDialogDismiss } from './DialogDismiss.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import type { ChatSession, ChatWorkspaceController } from './chat-session.ts';

export function ChatPermissionPicker({ name, session, controller }: { name: string; session: ChatSession; controller?: ChatWorkspaceController }) {
 const id = useId();
 const panel = useRef<HTMLDivElement>(null);
 const trigger = useRef<HTMLButtonElement>(null);
 const [view, setView] = useState<'menu' | 'help' | { permissionKey: string }>();
 const open = view === 'menu' || view === 'help';
 const confirmation = typeof view === 'object' && view.permissionKey === session.materialPermissionKey ? view : undefined;
 const close = (focus = false) => { setView(undefined); if (focus) trigger.current?.focus(); };
 useEffect(() => {
  if (!open && !confirmation) return;
  function dismiss(event: PointerEvent) { if (!panel.current?.contains(event.target as Node)) setView(undefined); }
  const hide = () => { if (document.visibilityState === 'hidden') setView(undefined); };
  if (open) document.addEventListener('pointerdown', dismiss);
  document.addEventListener('visibilitychange', hide);
  return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('visibilitychange', hide); };
 }, [open, confirmation]);
 useEffect(() => {
  if (typeof view === 'object' && !confirmation) setView(undefined);
 }, [view, confirmation]);
 return <div className="chat-permission-picker" ref={panel} onBlur={event => {
  if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close();
 }} onKeyDown={event => {
  if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
 }}>
  <button ref={trigger} type="button" className="chat-composer-permission" aria-expanded={open} aria-controls={open ? id : undefined}
   data-full={session.fullyAllowed || undefined} onClick={() => open ? close() : setView('menu')}>{session.fullyAllowed ? '完全允许' : '请求批准'}</button>
  {open && <div className="chat-permission-popover" id={id} role="group" aria-labelledby={`${id}-title`}>
   <header><span id={`${id}-title`}>应如何批准 {name} 操作？</span><button type="button" aria-expanded={view === 'help'} onClick={() => setView(view === 'help' ? 'menu' : 'help')}>了解更多</button></header>
   <button type="button" className="chat-permission-option" aria-pressed={!session.fullyAllowed} onClick={() => { controller?.setMaterialPermission(false, session.editorKey); close(true); }}>
    <PetNookIcon name="approvalHand" /><span><strong>请求批准</strong><small>发送附件前先询问</small></span>{!session.fullyAllowed && <PetNookIcon name="check" />}
   </button>
   <button type="button" className="chat-permission-option full" aria-pressed={!!session.fullyAllowed}
    aria-haspopup={!session.fullyAllowed ? 'dialog' : undefined} disabled={!controller || !session.materialPermissionKey || session.pending}
    onClick={() => {
     if (session.fullyAllowed) close(true);
     else if (session.materialPermissionKey) setView({ permissionKey: session.materialPermissionKey });
    }}>
    <PetNookIcon name="approvalShield" /><span><strong>完全允许</strong><small>仅放行本轮已选附件</small></span>{session.fullyAllowed && <PetNookIcon name="check" />}
   </button>
   {view === 'help' && <p className="chat-permission-note">仅控制本轮附件是否发送给所选模型。项目文件夹不会授权读取其他文件、执行命令或访问网络。</p>}
  </div>}
  {confirmation && <FullPermissionDialog name={name} returnFocus={trigger} onCancel={close} onConfirm={() => {
   // Do not approve a draft or route changed asynchronously while the warning was open.
   controller?.setMaterialPermission(true, session.editorKey, confirmation.permissionKey);
   close();
  }} />}
 </div>;
}

function FullPermissionDialog({ name, returnFocus, onCancel, onConfirm }: {
 name: string; returnFocus: RefObject<HTMLButtonElement | null>; onCancel(): void; onConfirm(): void;
}) {
 const id = useId();
 const dialog = useRef<HTMLDialogElement>(null);
 const cancel = useRef<HTMLButtonElement>(null);
 const [help, setHelp] = useState(false);
 const dismiss = useDialogDismiss(onCancel);
 useEffect(() => {
  const element = dialog.current!;
  element.showModal();
  cancel.current?.focus();
  return () => {
   element.close();
   if (document.visibilityState !== 'hidden') returnFocus.current?.focus();
  };
 }, [returnFocus]);
 return <dialog ref={dialog} className="chat-permission-dialog" role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`}
  {...dismiss} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
  <h2 id={`${id}-title`}><PetNookIcon name="warning" />要开启本轮完全允许吗？</h2>
  <p id={`${id}-intro`} className="chat-permission-intro">发送时，{name} 会把本轮已选附件交给当前模型处理，不再逐次询问。这不会扩大桌宠的系统权限。</p>
  <ul className="chat-permission-scopes" aria-label="完全允许的范围">
   <li><PetNookIcon name="folder" /><span><strong>本轮已选附件</strong><small>只处理已选附件，不读取其他文件或目录</small></span></li>
   <li><PetNookIcon name="terminal" /><span><strong>终端命令</strong><small>不授予命令执行、软件安装或修改系统设置的权限</small></span></li>
   <li><PetNookIcon name="globe" /><span><strong>互联网访问</strong><small>只发往所选模型，不授予自由访问网站的权限</small></span></li>
  </ul>
  <p className="chat-permission-risk">请确认附件不含敏感信息。修改草稿、附件或模型后需重新确认。 <button type="button" aria-expanded={help} aria-controls={`${id}-help`} onClick={() => setHelp(!help)}>了解更多</button></p>
  <p id={`${id}-help`} className="chat-permission-help" hidden={!help}>仅点击确认不会发送任何附件。发送后或更改本轮内容时，会恢复为「请求批准」。</p>
  <footer>
   <button type="button" ref={cancel} onClick={onCancel}>取消</button>
   <button type="button" className="chat-permission-confirm" onClick={onConfirm}><PetNookIcon name="warning" />确认</button>
  </footer>
 </dialog>;
}
