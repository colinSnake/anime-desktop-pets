import { useEffect, useRef, useState } from 'react';
import { chatHistoryTitle, isChatProject, isHistoryDetailResult, isHistoryResult, isProjectListResult, validChatProjectName, type ChatHistoryBridge, type ChatHistoryPage, type ChatProject, type ChatProjectBridge } from '../../../packages/contracts/src/chat-history.ts';
import { PetNookIcon } from './PetNookIcon.tsx';
import type { ChatWorkspaceController, ChatWorkspaceState } from './chat-session.ts';

type Props = { petID: string; projects: ChatProjectBridge; history: ChatHistoryBridge; state: ChatWorkspaceState; controller: ChatWorkspaceController };
const unassigned = 'unassigned';
const createErrors = { invalid_request: '请检查文件夹名称。', unavailable: '无法新建项目。', cancelled: '', busy: '暂时无法再新建项目。', exists: '这个位置已有同名项目文件夹，请换一个名称或位置。', not_found: '当前桌宠不再可用。', unregistered: '文件夹已创建，但未能确认项目已登记；请刷新列表。' } as const;

export function ChatProjectNavigation({ petID, projects, history, state, controller }: Props) {
 const [folders, setFolders] = useState<ChatProject[]>([]);
 const [scope, setScope] = useState(state.session.projectID ?? unassigned);
 const [sessionList, setSessionList] = useState<{ scope: string; page: ChatHistoryPage }>();
 const [revision, refresh] = useState(0);
 const [notice, setNotice] = useState('');
 const [listError, setListError] = useState(false);
 const [historyError, setHistoryError] = useState(false);
 const [creating, setCreating] = useState(false);
 const [name, setName] = useState('');
 const [busy, setBusy] = useState(false);
 const [reading, setReading] = useState(false);
 const [pageCursor, setCursor] = useState<string>();
 const alive = useRef(false);
 const openScope = useRef(scope);
 const editor = state.session.editorKey;
 useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
 useEffect(() => {
  let current = true;
  setListError(false);
  void projects.list({ petID }).then(result => {
   if (!current) return;
   if (isProjectListResult(result) && result.ok) setFolders(result.projects);
   else setListError(true);
  }, () => { if (current) setListError(true); });
  return () => { current = false; };
 }, [projects, petID, revision]);
 useEffect(() => {
  let current = true;
  setSessionList(undefined); setHistoryError(false);
  const input = { petID, projectID: scope, ...(pageCursor && { before: pageCursor }) };
  void history.list(input).then(result => {
   if (!current) return;
   if (isHistoryResult('list', input, result) && result.ok) setSessionList({ scope, page: result.page });
   else setHistoryError(true);
  }, () => { if (current) setHistoryError(true); });
  return () => { current = false; };
 }, [history, petID, scope, pageCursor, revision, state.session.savedTurnID, state.historyEpoch]);
 const show = (id: string) => { openScope.current = id; setScope(id); setCursor(undefined); };
 const start = (id: string, name: string) => {
  if (controller.newConversation(id === unassigned ? undefined : id, name)) { show(id); setNotice(''); }
  else setNotice('暂时无法切换会话，请先结束当前回复或整理未发送的草稿。');
 };
 const create = async () => {
  const candidate = name.trim();
  if (busy || !validChatProjectName(candidate)) return;
  setBusy(true); setNotice('');
  try {
   const result = await projects.create({ petID, name: candidate });
   if (!alive.current) return;
   if (result.ok && isChatProject(result.project) && result.project.name === candidate) {
    setFolders(current => [result.project, ...current.filter(folder => folder.id !== result.project.id)]);
    show(result.project.id); setCreating(false); setName('');
    refresh(value => value + 1);
   } else if (!result.ok) setNotice(createErrors[result.error] ?? '无法新建项目。');
  } catch { if (alive.current) setNotice('未能确认是否已创建项目，请刷新列表。'); }
  finally { if (alive.current) setBusy(false); }
 };
 const resume = async (id: string, group: string, name: string) => {
  if (reading || state.session.pending) return;
  setReading(true); setNotice('');
  const selected = () => alive.current && openScope.current === group && controller.getSnapshot().selectedId === petID && controller.getSnapshot().session.editorKey === editor;
  try {
   const result = await history.detail({ petID, id });
   if (!selected()) return;
   if (!(isHistoryDetailResult(result, id) && result.ok && (result.detail.session.projectID ?? unassigned) === group && controller.continueConversation(petID, result.detail, name))) setNotice('暂时无法打开该会话。');
  } catch { if (selected()) setNotice('暂时无法打开该会话。'); }
  finally { if (alive.current) setReading(false); }
 };
 return <section className="chat-project-nav" aria-label="聊天项目和会话">
  <header><h2>项目与会话</h2><button type="button" className="chat-project-icon" aria-label="新建项目文件夹" aria-expanded={creating} disabled={busy} onClick={() => { setCreating(!creating); setNotice(''); }}><PetNookIcon name="plus" /></button></header>
  {creating && <form className="chat-project-form" onSubmit={event => { event.preventDefault(); void create(); }}>
   <label>文件夹名称<input value={name} maxLength={60} disabled={busy} onChange={event => setName(event.currentTarget.value)} placeholder="例如：周末计划" /></label>
   <button className="chat-control" type="submit" disabled={busy || !validChatProjectName(name.trim())}>{busy ? '正在等待文件夹选择…' : '选择位置并创建'}</button>
  </form>}
  {notice && <p className="chat-project-status" role="status">{notice}</p>}
  {(listError || historyError) && <button type="button" className="chat-control" onClick={() => refresh(value => value + 1)}>重试读取</button>}
  {[{ id: unassigned, name: '未分配会话' }, ...folders].map(folder => <div className="chat-project-group" key={folder.id}>
   <div className="chat-project-row">
    <button type="button" className="chat-project-name" aria-expanded={scope === folder.id} title={folder.name} onClick={() => show(folder.id)}>
     <PetNookIcon name={folder.id === unassigned ? 'chat' : 'folder'} /><span>{folder.name}</span>
    </button>
    <button type="button" className="chat-project-icon" disabled={state.session.pending} title="新建会话" aria-label={`在${folder.name}中新建会话`} onClick={() => start(folder.id, folder.name)}><PetNookIcon name="plus" /></button>
   </div>
   {scope === folder.id && sessionList?.scope === scope && <div className="chat-project-sessions">
    {sessionList.page.rows.map(session => <button key={session.id} type="button" className="chat-project-session" disabled={reading || state.session.pending}
     onClick={() => void resume(session.id, folder.id, folder.name)}>{chatHistoryTitle(session)}</button>)}
    {!sessionList.page.rows.length && !pageCursor && <span>暂无已保存会话</span>}
    {pageCursor && <button type="button" className="chat-project-session" onClick={() => setCursor(undefined)}>返回最新</button>}
    {sessionList.page.nextBefore && <button type="button" className="chat-project-session" onClick={() => setCursor(sessionList.page.nextBefore ?? undefined)}>更早会话</button>}
   </div>}
  </div>)}
 </section>;
}
