import type { DesktopBridge } from '../../../../packages/contracts/src/index.ts';
import { LiveVoiceProfile } from './LiveVoiceProfile.tsx';
import { LiveLearning } from './LiveLearning.tsx';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { defaultLiveProfile, liveRoleActions, liveScenes, type LiveRoleActionId, type LiveDanmakuState, type LiveError, type LiveProfile, type LiveResult, type LiveRoleId, type LiveScene, type LiveStageBridge, type LiveVoiceState } from '../../../../packages/contracts/src/live-stage.ts';
import { dafeiyu, longmei } from '../../../../packages/contracts/src/built-in-pets.ts';
import { ImagePreview } from '../ImagePreview.tsx';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { PetCover } from '../PetCover.tsx';
import { LiveSettingsDrawer } from './LiveSettingsDrawer.tsx';
import { LiveSharing } from './LiveSharing.tsx';
import { InteractionLayout } from './InteractionLayout.tsx';
import { danmakuWorking, LiveDanmaku } from './LiveDanmaku.tsx';

const roles = [
  { id: 'longmei', name: '龙妹', reference: longmei },
  { id: 'dafeiyu', name: '鲸鱼妹', reference: dafeiyu },
] as const;

type StageOperation = 'read' | 'start' | 'stop' | 'save' | 'switchScene' | 'preview' | 'copy' | 'trigger' | 'submitDanmaku';

const problems: Record<LiveError, string> = {
  migration: '此功能需要先在新本机资料目录中初始化工作区。',
  unbound: '请先将该角色绑定到已登记的对应桌宠实例。',
  'role-mismatch': '绑定的桌宠角色或版本已变化，请重新绑定后重试。',
  unavailable: '未能确认操作结果。请重新读取舞台状态。',
  storage: '未能确认布景配置。原文件不会被自动重置，请先重新读取。',
  busy: '舞台正在处理其他操作，或桌宠联动已暂停。',
  media: '未能准备节目画面。请重试；若仍失败，请检查该角色的本机素材及桌面工作区启动日志。',
};
const actionIcons:Record<string,'chat'|'spark'|'pulse'> = {'01':'chat','18':'spark','20':'pulse','companion-wave':'chat','companion-jump':'spark','companion-49c0d89c0992':'pulse'};
const artwork = (id: LiveScene, size: 'cover' | 'preview') => `pet-app://workspace/live-stage/${id}-${size}.webp`;
const equal = (a: LiveProfile, b: LiveProfile) => a.selected === b.selected && liveScenes.every(({id}) => a.scenes[id].position === b.scenes[id].position && a.scenes[id].scale === b.scenes[id].scale);
const missing = {ok:false,error:'unavailable'} as const;
const call = async (op: () => Promise<LiveResult>): Promise<LiveResult> => { try { return await op(); } catch { return missing; } };

export function LivePage({appearance,bridge,paused,characters,instances=[]}:{appearance?:ReactNode;bridge?:LiveStageBridge;paused?:boolean;characters?:DesktopBridge['characters'];instances?:Array<{id:string;displayName?:string;package:{id:string;version:string}}>}) {
  const [preview, setPreview] = useState<{ id: LiveScene; name: string; opener: HTMLButtonElement }>();
  const [role, setRole] = useState<(typeof roles)[number]>(roles[0]);
  const [bindings,setBindings]=useState<{revision:number;bindings:Record<LiveRoleId,string|null>}>({revision:0,bindings:{longmei:null,dafeiyu:null}});
  const [bindingBusy,setBindingBusy]=useState(false);
  const [bindingNeedsRead,setBindingNeedsRead]=useState(true);
  const [bindingReadRequest,setBindingReadRequest]=useState(0);
  const [panel, setPanel] = useState<'binding' | 'placement'>();
  const [bindingDraft, setBindingDraft] = useState('');
  const [voiceConfigBusy,setVoiceConfigBusy]=useState(false);
  const [sharingBusy,setSharingBusy]=useState(false);
  const [bindingMessage,setBindingMessage]=useState('');
  const [draft,setDraft] = useState(defaultLiveProfile);
  const [saved,setSaved] = useState<LiveProfile>();
  const [voice,setVoice] = useState<LiveVoiceState>();
  const [danmaku,setDanmaku] = useState<LiveDanmakuState>();
  const [danmakuNotice,setDanmakuNotice] = useState('');
  const unsettledDanmaku = useRef(false);
  const [running,setRunning] = useState(false);
  const [busy,setBusy] = useState<StageOperation>();
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [sceneNotice,setSceneNotice] = useState('');
  const [needsRead,setNeedsRead] = useState(false);
  const [startFailed,setStartFailed] = useState(false);
  const gate = useRef(false);
  const requestRevision = useRef(0);
  const held = useRef(false);
  const currentRole = useRef(role.id);
  currentRole.current = role.id;
  useEffect(() => {
    held.current = true;
    return () => {
      held.current = false;
      requestRevision.current++;
      if (unsettledDanmaku.current && bridge?.stopDanmaku) void call(() => bridge.stopDanmaku!(currentRole.current));
      unsettledDanmaku.current = false;
    };
  }, [bridge]);
  function acceptDanmaku(state?: LiveDanmakuState) {
    unsettledDanmaku.current = danmakuWorking(state) || state?.phase === 'published';
    setDanmaku(state);
  }
  const trackingDanmaku = danmakuWorking(danmaku);

  useEffect(() => {
    setBindingNeedsRead(true);
    if (!bridge?.readBindings) { setBindingBusy(false); return; }
    let mounted = true;
    setBindingBusy(true); setBindingMessage('正在读取角色绑定…');
    void bridge.readBindings().then(result => {
      if (!mounted) return;
      if (result.ok) {
        setBindings({revision:result.revision,bindings:result.bindings});
        setBindingDraft(result.bindings[currentRole.current] ?? '');
        setBindingNeedsRead(false); setBindingMessage('');
      } else setBindingMessage('未能读取角色绑定；请重新读取绑定。');
    }).catch(() => {
      if (mounted) setBindingMessage('未能读取角色绑定；请重新读取绑定。');
    }).finally(() => { if (mounted) setBindingBusy(false); });
    return () => { mounted = false; };
  }, [bridge, bindingReadRequest]);
  async function bindRole(roleID:LiveRoleId,petID:string|null){
    if(!bridge?.writeBinding||bindingNeedsRead||bindingBusy||voiceConfigBusy||sharingBusy||running||gate.current)return false;setBindingBusy(true);setBindingMessage('');
    try{const result=await bridge.writeBinding({expectedRevision:bindings.revision,role:roleID,petID});if(!result.ok){setBindingNeedsRead(true);setBindingMessage(result.error==='conflict'?'绑定已在其他操作中更新，请重新读取。':'无法确认绑定保存，请重新读取。');return false;}
      setBindings({revision:result.revision,bindings:result.bindings});setBindingMessage(petID?'角色绑定已保存。':'角色已解绑。');
      if(role.id===roleID)void run('read',()=>bridge.read(roleID));
      return true;
    }catch{setBindingNeedsRead(true);setBindingMessage('无法确认绑定保存，请重新读取。');return false;}finally{setBindingBusy(false);}
  }
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    gate.current = true; setBusy('read');
    void call(() => bridge.read(role.id)).then(result => {
      if (!mounted) return;
      gate.current = false; setBusy(undefined);
      if (result.ok) { adoptActiveRole(result); setSaved(result.profile); setDraft(result.profile); setRunning(result.running); setVoice(result.voice); acceptDanmaku(result.danmaku); }
      else { setError(problems[result.error]); setNeedsRead(true); }
    });
    return () => { mounted = false; };
  }, [bridge]);

  function adoptActiveRole(result:Extract<LiveResult,{ok:true}>) {
    const current = result.running && roles.find(option=>option.id===result.activeRole);
    if(current && current.id!==currentRole.current){currentRole.current=current.id;setRole(current);}
  }

  async function run(kind: StageOperation, op: () => Promise<LiveResult>, success = ''): Promise<boolean> {
    if (gate.current || !held.current) return false;
    const revision = ++requestRevision.current;
    gate.current = true; setBusy(kind);
    const rehearsal = kind === 'submitDanmaku';
    if (rehearsal) {
      setDanmakuNotice('');
      unsettledDanmaku.current = true;
    } else if (kind !== 'switchScene') { setError(''); setNotice(''); setSceneNotice(''); }

    const result = await call(op);
    if (!held.current || revision !== requestRevision.current) return false;
    gate.current = false; setBusy(undefined);
    if (!result.ok) {
      if (kind === 'switchScene') {
        setSceneNotice(result.error === 'busy' ? '舞台忙，稍后再换景。' : '未能确认换景，请重新读取状态。');
        if (result.error !== 'busy') setNeedsRead(true);
        return false;
      }
      if (rehearsal) {
        setDanmakuNotice(result.error === 'busy' ? '正在播放手动动作，或上一条演练还没结束。请稍后再试。' : '未能确认演练操作，请检查舞台与声轨状态。');
        return false;
      }
      setError(problems[result.error]);
      if (kind === 'start') setStartFailed(true);
      if (kind === 'read' || (kind === 'save' && result.error !== 'busy') || result.error === 'unavailable') setNeedsRead(true);
      return false;
    }
    adoptActiveRole(result); setRunning(result.running); setVoice(result.voice); acceptDanmaku(result.danmaku); setStartFailed(false);
    if (!rehearsal && (kind === 'start' || kind === 'stop')) setDanmakuNotice('');
    if (kind === 'switchScene') setSceneNotice(success);
    else setNotice(success);
    if (kind === 'read' || kind === 'save' || kind === 'switchScene' || kind === 'start') {
      setNeedsRead(false); setSaved(result.profile);
      if (kind !== 'read' || !saved || equal(draft,saved) || result.running) setDraft(result.profile);
    }
    return true;
  }
  useEffect(() => {
    if (!bridge || !running) return;
    let mounted = true, checking = false;
    // A tray pause or service exit can retire output without going through this page.
    const refresh = async () => {
      if (document.hidden || gate.current || checking) return;
      const revision = requestRevision.current;
      checking = true;
      const result = await call(() => bridge.read(role.id));
      checking = false;
      if (!mounted || gate.current || revision !== requestRevision.current) return;
      if (!result.ok) {
        setNeedsRead(true); setError(problems[result.error]);
      } else {
        setVoice(result.voice); acceptDanmaku(result.danmaku);
        if (!result.running) { setRunning(false); setNotice('本机舞台已关闭；不会自动重开。'); }
      }
    };
    const timer = window.setInterval(() => void refresh(), trackingDanmaku ? 650 : 2000);
    window.addEventListener('focus', refresh);
    return () => { mounted = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [bridge,role.id,running,trackingDanmaku]);

  const roleActions=liveRoleActions[role.id] as Record<string,{label:string;line:string}>;
  const orderedActions=role.id==='longmei'?['01','18','20']:['companion-wave','companion-jump','companion-49c0d89c0992'];
  const placement = draft.scenes[draft.selected];
  const scene = liveScenes.find(scene => scene.id === draft.selected)!;
  const dirty = !!saved && !equal(draft, saved);
  const supported = true;
  const editable = supported && !!bridge && !!saved && !running && !busy && !paused && !needsRead && !voiceConfigBusy && !sharingBusy && !bindingBusy;
  // Keep the same controls and keyboard focus while a scene write holds the operation gate.
  const switching = busy === 'switchScene';
  const actionBusy = !!busy && !switching;
  const active = supported && !!bridge && running && !actionBusy && !paused && !needsRead;
  const voiceHint = !running ? ''
    : voice === 'reference-required' ? '请停台，在「专属音色」为当前主播实例保存参考 WAV 和逐字稿。'
    : voice === 'voice-busy' ? '本机语音忙，节目暂时静音。等当前语音任务结束后重新开台。'
    : voice === 'voice-failed' ? '当前主播音色准备失败，节目保持静音。请检查本机音色后重新开台。'
    : voice === undefined ? '此环境未接入本机语音运行时。'
    : '';
  const canSwitchScene = typeof bridge?.switchScene === 'function';
  const canChooseScene = editable || (active && canSwitchScene);
  const canChooseRole = !voiceConfigBusy && !sharingBusy && !bindingBusy && !running && !busy && !needsRead && (!bridge || !!saved);
  const reading = busy === 'read' || (!!bridge && !saved && !needsRead);
  const status = !bridge ? '未连接桌面工作区' : reading ? '读取中' : busy === 'start' ? '准备中'
    : busy === 'stop' ? '关闭中' : needsRead ? '状态待确认' : running ? '舞台可用' : paused ? '联动已暂停' : startFailed ? '开启失败' : '舞台未开启';
  const outputState = reading || busy === 'start' || busy === 'stop' ? 'pending'
    : needsRead || startFailed ? 'error' : running ? 'ready' : 'idle';
  const primary = needsRead ? '重新读取状态' : running || busy === 'stop' ? (busy === 'stop' ? '关闭中…' : '关闭直播台')
    : busy === 'start' ? '准备中…' : startFailed ? '重试开启' : '开启直播台';
  const update = (key: 'position' | 'scale', value: number) => setDraft(previous => ({
    ...previous, scenes: { ...previous.scenes, [previous.selected]: { ...previous.scenes[previous.selected], [key]: value } },
  }));
  function selectScene(scene: typeof liveScenes[number]) {
    if (!canChooseScene || gate.current) return;
    if (running && bridge) void run('switchScene', () => bridge.switchScene(scene.id,role.id), `已切换为${scene.name}，OBS 地址不变。`);
    else setDraft(value => ({ ...value, selected: scene.id }));
  }
  function mainAction() {
    if (!bridge || !supported) return;
    if (needsRead) void run('read', () => bridge.read(role.id));
    else if (running) void run('stop', () => bridge.stop(role.id), '已关闭本机舞台。');
    else if (editable && !dirty && !bindingNeedsRead && bindings.bindings[role.id]) void run('start', () => bridge.start(role.id), '本机画面源已开启。');
  }
  const petID = bindings.bindings[role.id];
  const learning = danmaku?.phase === 'published' && danmaku.learning?.petID === petID ? danmaku.learning : undefined;
  const boundInstance = instances.find(item => item.id === petID);
  const canReadBindings = !!bridge?.readBindings && !bindingBusy && !voiceConfigBusy && !sharingBusy && !busy && !running;
  const canBind = !!bridge?.writeBinding && !bindingNeedsRead && !bindingBusy && !voiceConfigBusy && !sharingBusy && !busy && !running;
  const bindingStatus = <>{bindingMessage && <p className="live-hint" role="status">{bindingMessage}</p>}{bindingNeedsRead && bridge?.readBindings && <button type="button" className="interaction-button quiet" disabled={!canReadBindings} onClick={() => { if (!canReadBindings || gate.current) return; setBindingBusy(true); setBindingReadRequest(value => value + 1); }}><PetNookIcon name="refresh" />重新读取绑定</button>}</>;
  const openBinding = () => { setBindingDraft(petID ?? ''); setPanel('binding'); };
  const primaryAction = <button type="button" className="interaction-button primary live-main-action" aria-disabled={switching || undefined}
    disabled={!bridge || actionBusy || (!needsRead && !running && (!editable || dirty || bindingNeedsRead || !petID))} onClick={mainAction}>
    <PetNookIcon name={needsRead ? 'refresh' : running ? 'close' : 'live'} />{primary}
  </button>;

  return <InteractionLayout page="live" title="直播工作台" description="在本机搭好舞台，再把她带进直播间。" appearance={<div className="live-toolbar-actions">{primaryAction}{appearance}</div>}>
    <div className="live-workbench">
      <div className="live-workbench-main">
        <section className="live-workbench-stage" aria-labelledby="stage-output-title">
          <header className="live-workbench-stage-heading">
            <div><PetNookIcon name="live" /><h2 id="stage-output-title">舞台预览</h2><span className="live-status" data-state={outputState} role="status">{status}</span></div>
            <div className="live-workbench-specs"><span>1920 × 1080</span><span>16:9</span><button type="button" className="live-workbench-icon-button" aria-label="预览舞台" disabled={!active} aria-disabled={switching || undefined} onClick={() => void run('preview', () => bridge!.preview(role.id))}><PetNookIcon name="expand" /></button></div>
          </header>
          <div className="live-workbench-art">
            <img className="live-workbench-background" src={artwork(draft.selected, 'preview')} alt={scene.name} draggable={false} />
            {petID ? <div className="live-workbench-pet" style={{left:`${placement.position}%`,width:`${28*placement.scale/100}%`,height:`${68*placement.scale/100}%`}}><PetCover reference={role.reference} /></div> : <div className="live-workbench-unbound"><PetNookIcon name="spark" /><h3>她的舞台，等你开启</h3><p>先为{role.name}绑定一只桌宠实例</p><button type="button" className="interaction-button primary" disabled={!canBind} onClick={openBinding}>绑定桌宠</button></div>}
            <span className="live-workbench-art-label"><PetNookIcon name="display" />布景示意 · 非实时画面</span>
          </div>
          <footer className="live-workbench-output">
            <div><span className="live-workbench-output-icon"><PetNookIcon name="globe" /></span><div><h3>OBS 浏览器源</h3><p>{running ? '本机舞台已开启，可复制地址添加到 OBS。' : '开台后生成本机地址，不会自动推流。'}</p></div></div>
            <button type="button" className="interaction-button secondary" aria-disabled={switching || undefined} disabled={!active} onClick={() => void run('copy', () => bridge!.copy(role.id), '已复制本机 OBS 地址。')}><PetNookIcon name="globe" />复制 OBS 地址</button>
          </footer>
        </section>
        {(voiceHint || error || notice || paused) && <div className="live-workbench-feedback">
          {voiceHint && <p className="live-hint" role="status">{voiceHint}</p>}
          {error ? <div className="live-feedback"><p role="alert"><PetNookIcon name="warning" />{error}</p>{needsRead && <button type="button" className="interaction-button quiet" disabled={!bridge || !!busy} onClick={() => void run('stop', () => bridge!.stop(role.id), '已关闭本机舞台，请重新读取状态。')}>关闭可能运行的舞台</button>}</div> : notice && <p className="live-message" role="status">{notice}</p>}
          {paused && <p className="live-hint">桌宠联动已暂停；解除暂停后可手动开启。</p>}
        </div>}
        <section className="live-workbench-scenes" aria-labelledby="live-scenes-title">
          <div className="live-workbench-section-heading"><div><h2 id="live-scenes-title">选择布景</h2><p>{running ? '点击直接换景，OBS 地址保持不变。' : '六个小世界，总有一个适合今天。'}</p></div><button type="button" className="interaction-button quiet" aria-haspopup="dialog" disabled={!editable} onClick={() => setPanel('placement')}><PetNookIcon name="advanced" />调整摆位<PetNookIcon name="chevron" /></button></div>
          {running && !canSwitchScene && <p className="live-hint">此版本不支持开台换景。</p>}
          <fieldset className="live-scene-picker"><legend className="sr-only">直播布景</legend><div className="live-scene-list">{liveScenes.map(scene => <div className="live-scene-option" key={scene.id}>
            <label className={`live-scene-choice${draft.selected === scene.id ? ' selected' : ''}`}>
              <input type="radio" name="live-stage-scene" checked={draft.selected === scene.id} disabled={!canChooseScene} aria-disabled={switching || undefined} onChange={() => selectScene(scene)} />
              <span className="live-scene-art"><img src={artwork(scene.id, 'cover')} alt="" draggable={false} onError={event => { event.currentTarget.hidden = true; }} /></span>
              <span className="live-scene-caption"><strong>{scene.name}</strong>{draft.selected === scene.id && <small aria-hidden="true"><PetNookIcon name="check" /><span className="sr-only">已选中</span></small>}</span>
            </label>
            <button type="button" className="live-scene-preview" aria-label={`预览布景：${scene.name}`} aria-haspopup="dialog" title={`预览${scene.name}`} onClick={event => setPreview({ id: scene.id, name: scene.name, opener: event.currentTarget })}><PetNookIcon name="expand" /></button>
          </div>)}</div></fieldset>
          <div className="live-workbench-scene-footer"><p className="live-hint" role="status">{switching ? '正在切换布景…' : running ? sceneNotice || '关闭舞台后可切换桌宠或调整摆位。' : dirty ? '有未保存的修改；先保存布景，再开启直播台。' : '更换主播或调整摆位前，需要先关闭直播台。'}</p>{dirty && !running && <button type="button" className="interaction-button secondary" disabled={!editable} onClick={() => void run('save', () => bridge!.save(draft,role.id))}>保存布景</button>}</div>
        </section>
      </div>
      <aside className="live-workbench-controls" aria-label="主播与互动控制">
        <section className="live-workbench-presenter" aria-labelledby="live-presenter-title">
          <div className="live-workbench-section-heading"><h2 id="live-presenter-title">今天，谁来当主播？</h2><span>{running ? '开台中已锁定' : '停台时可切换'}</span></div>
          <div className="live-workbench-roles" aria-label="直播桌宠">{roles.map(option => <button type="button" key={option.id} className={`live-workbench-role${role.id === option.id ? ' selected' : ''}`} disabled={!canChooseRole} aria-pressed={role.id === option.id} aria-describedby={running ? 'live-role-lock' : undefined} onClick={() => { if (gate.current || option.id === role.id) return; setRole(option); setPanel(undefined); if (bridge) void run('read', () => bridge.read(option.id)); }}><PetCover reference={option.reference} avatar /><span>{option.name}</span>{role.id === option.id && <PetNookIcon name="check" />}</button>)}</div>
          <div className="live-workbench-binding"><div><span>绑定实例</span><strong>{petID ? boundInstance?.displayName || role.name : '尚未绑定'}</strong></div><button type="button" className="interaction-button quiet" aria-haspopup="dialog" disabled={!canBind} onClick={openBinding}>{petID ? '更换' : '去绑定'}<PetNookIcon name="chevron" /></button></div>
          {bindingStatus}
          <div className="live-workbench-config">
            <LiveVoiceProfile key={`voice:${role.id}:${bindings.revision}:${petID}`} name={role.name} instanceName={boundInstance?.displayName || role.name} target={petID?{role:role.id,petID,bindingRevision:bindings.revision}:undefined} bridge={bridge?.voiceProfile} locked={running||!!busy||!!paused||bindingBusy||bindingNeedsRead||sharingBusy} onBusy={setVoiceConfigBusy} />
            <LiveSharing key={`sharing:${role.id}:${bindings.revision}:${petID}`} name={role.name} role={role.id} petID={petID} bridge={bridge} locked={bindingBusy||bindingNeedsRead||voiceConfigBusy||!!busy||needsRead} onBusy={setSharingBusy} />
          </div>
          <p className="live-workbench-private"><PetNookIcon name="lock" />音色按实例独立保存，授权与聊天分开。</p>
        </section>
        <section className="live-workbench-interactions" aria-labelledby="stage-action-title">
          <div className="live-workbench-section-heading"><h2 id="stage-action-title">主播互动</h2><span>{running ? voice === 'ready' ? '声轨已就绪' : '当前声轨未就绪' : '开台后可用'}</span></div>
          <div className="live-action-list">{orderedActions.map(id => { const action=roleActions[id]; return action && <button key={id} type="button" className="interaction-button secondary" aria-disabled={switching || undefined} disabled={!active} onClick={() => void run('trigger', () => bridge!.trigger(id as LiveRoleActionId,role.id))}><PetNookIcon name={actionIcons[id] ?? 'chat'} />{action.label}</button>; })}</div>
          <LiveDanmaku state={danmaku} notice={danmakuNotice} locked={!!busy} available={active && voice === 'ready' && !!bridge?.submitDanmaku} unavailableHint={running && !bridge?.submitDanmaku ? '此工作区不支持弹幕演练。' : running && voice !== 'ready' ? '当前角色声轨就绪后才可发送演练。' : ''} onSend={async text => bridge?.submitDanmaku ? run('submitDanmaku', () => bridge.submitDanmaku!(text,role.id)) : false} />
          {running && !paused && learning && bridge?.learning && <LiveLearning key={learning.ticket} bridge={bridge.learning} handle={learning} role={role.id} locked={!active} characters={characters} onUnknown={()=>{if(held.current&&!document.hidden)setDanmakuNotice('未能确认候选是否保存。请到「聊天 → 桌宠 Agent → 记忆」核对，不会自动重试。');}} />}
        </section>
      </aside>
    </div>
    {running && <span className="sr-only" id="live-role-lock">关闭舞台后可切换桌宠或调整摆位。</span>}
    {panel === 'binding' && <LiveSettingsDrawer title="绑定桌宠实例" subtitle={`为${role.name}选择一个已登记的实例`} busy={bindingBusy || !!busy} onClose={() => setPanel(undefined)} footer={<><button type="button" className="interaction-button secondary" disabled={bindingBusy || !!busy} onClick={() => setPanel(undefined)}>取消</button><button type="button" className="interaction-button primary" disabled={!canBind || bindingDraft === (petID ?? '')} onClick={async () => { if (await bindRole(role.id,bindingDraft || null)) setPanel(undefined); }}>确认绑定</button></>}>
      <label className="live-workbench-field" htmlFor="live-role-instance">{role.name}绑定的桌宠实例</label>
      <select id="live-role-instance" value={bindingDraft} disabled={!canBind} onChange={event => setBindingDraft(event.currentTarget.value)}><option value="">未绑定</option>{instances.filter(item=>item.package.id===role.reference.id&&item.package.version===role.reference.version&&bindings.bindings[role.id==='longmei'?'dafeiyu':'longmei']!==item.id).map(item=><option key={item.id} value={item.id}>{item.displayName||item.id}</option>)}</select>
      <p className="live-hint">音色与直播授权跟随当前实例，不继承其他桌宠资料。</p>{bindingStatus}
    </LiveSettingsDrawer>}
    {panel === 'placement' && <LiveSettingsDrawer title="调整舞台摆位" subtitle={scene.name} busy={!!busy} onClose={() => setPanel(undefined)} footer={<><button type="button" className="interaction-button secondary" disabled={!!busy} onClick={() => setPanel(undefined)}>关闭</button><button type="button" className="interaction-button primary" disabled={!editable || !dirty} onClick={async () => { if (await run('save', () => bridge!.save(draft,role.id))) setPanel(undefined); }}>保存布景</button></>}>
      <img className="live-settings-scene" src={artwork(draft.selected,'cover')} alt={scene.name} /><fieldset className="live-placement" key={draft.selected} disabled={!editable}><legend className="sr-only">角色位置与大小（百分比）</legend><PlacementStepper label="横向位置" min={scene.positionMin} max={scene.positionMax} value={placement.position} onChange={value => update('position',value)} /><PlacementStepper label="角色大小" min={75} max={125} value={placement.scale} onChange={value => update('scale',value)} /></fieldset><p className="live-hint">每套布景独立保存百分比摆位。关闭抽屉保留未保存的修改。</p>
    </LiveSettingsDrawer>}
    {preview && <ImagePreview src={artwork(preview.id, 'preview')} alt={preview.name} downloadName={`${preview.name}.webp`} returnFocus={preview.opener} onDismiss={() => setPreview(undefined)} />}
  </InteractionLayout>;
}

function PlacementStepper({ label, min, max, value, onChange }: {
  label: string; min: number; max: number; value: number; onChange(value: number): void;
}) {
  const id = useId();
  const [entry, setEntry] = useState<string>();
  function finish(text: string) {
    const next = Number(text);
    if (text && Number.isInteger(next)) {
      const bounded = Math.min(max, Math.max(min, next));
      if (bounded !== value) onChange(bounded);
    }
    setEntry(undefined);
  }

  return <div className="live-placement-field">
    <label htmlFor={id}>{label}</label>
    <div className="live-placement-stepper">
      <button type="button" aria-label={`减少${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}><PetNookIcon name="minus" /></button>
      <div className="live-placement-value">
        <input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={entry ?? value}
          onChange={event => {
            const { value: text, valueAsNumber: next } = event.currentTarget;
            setEntry(text);
            if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
          }}
          onBlur={event => finish(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } }} />
        <span aria-hidden="true">%</span>
      </div>
      <button type="button" aria-label={`增加${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}><PetNookIcon name="plus" /></button>
    </div>
  </div>;
}
