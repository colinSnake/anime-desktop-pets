import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { defaultLiveProfile, liveRoleActions, liveScenes, type LiveRoleActionId, type LiveDanmakuState, type LiveError, type LiveProfile, type LiveResult, type LiveRoleId, type LiveScene, type LiveStageBridge, type LiveVoiceState } from '../../../../packages/contracts/src/live-stage.ts';
import { dafeiyu, longmei } from '../../../../packages/contracts/src/built-in-pets.ts';
import { ImagePreview } from '../ImagePreview.tsx';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { PetRolePicker } from '../PetRolePicker.tsx';
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

export function LivePage({appearance,bridge,paused,instances=[]}:{appearance?:ReactNode;bridge?:LiveStageBridge;paused?:boolean;instances?:Array<{id:string;displayName?:string;package:{id:string;version:string}}>}) {
  const [preview, setPreview] = useState<{ id: LiveScene; name: string; opener: HTMLButtonElement }>();
  const [role, setRole] = useState<(typeof roles)[number]>(roles[0]);
  const [bindings,setBindings]=useState<{revision:number;bindings:Record<LiveRoleId,string|null>}>({revision:0,bindings:{longmei:null,dafeiyu:null}});
  const [bindingBusy,setBindingBusy]=useState(false);
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
  useEffect(() => {
    held.current = true;
    return () => {
      held.current = false;
      requestRevision.current++;
      if (unsettledDanmaku.current && bridge?.stopDanmaku) void call(() => bridge.stopDanmaku!(role.id));
      unsettledDanmaku.current = false;
    };
  }, [bridge]);
  function acceptDanmaku(state?: LiveDanmakuState) {
    unsettledDanmaku.current = danmakuWorking(state);
    setDanmaku(state);
  }
  const trackingDanmaku = danmakuWorking(danmaku);

  useEffect(()=>{if(!bridge?.readBindings)return;let mounted=true;void bridge.readBindings().then(result=>{if(!mounted)return;if(result.ok){setBindings({revision:result.revision,bindings:result.bindings});setBindingMessage('');}else setBindingMessage('未能读取角色绑定；请重试。');}).catch(()=>{if(mounted)setBindingMessage('未能读取角色绑定；请重试。');});return()=>{mounted=false;};},[bridge]);
  async function bindRole(roleID:LiveRoleId,petID:string|null){
    if(!bridge?.writeBinding||bindingBusy)return;setBindingBusy(true);setBindingMessage('');
    try{const result=await bridge.writeBinding({expectedRevision:bindings.revision,role:roleID,petID});if(!result.ok){setBindingMessage(result.error==='conflict'?'绑定已在其他操作中更新，请重新读取。':'无法确认绑定保存，请重新读取。');return;}
      setBindings({revision:result.revision,bindings:result.bindings});setBindingMessage(petID?'角色绑定已保存。':'角色已解绑。');
      if(role.id===roleID)void run('read',()=>bridge.read(roleID));
    }catch{setBindingMessage('无法确认绑定保存，请重新读取。');}finally{setBindingBusy(false);}
  }
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    gate.current = true; setBusy('read');
    void call(() => bridge.read(role.id)).then(result => {
      if (!mounted) return;
      gate.current = false; setBusy(undefined);
      if (result.ok) { setSaved(result.profile); setDraft(result.profile); setRunning(result.running); setVoice(result.voice); acceptDanmaku(result.danmaku); }
      else { setError(problems[result.error]); setNeedsRead(true); }
    });
    return () => { mounted = false; };
  }, [bridge]);

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
    setRunning(result.running); setVoice(result.voice); acceptDanmaku(result.danmaku); setStartFailed(false);
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
  const editable = supported && !!bridge && !!saved && !running && !busy && !paused && !needsRead;
  // Keep the same controls and keyboard focus while a scene write holds the operation gate.
  const switching = busy === 'switchScene';
  const actionBusy = !!busy && !switching;
  const active = supported && !!bridge && running && !actionBusy && !paused && !needsRead;
  const voiceHint = !running ? ''
    : voice === 'reference-required' ? '请在「语音互动」保存参考 WAV 和逐字稿，再重新开启直播台。'
    : voice === 'voice-busy' ? '本机语音忙，节目暂时静音。等当前语音任务结束后重新开台。'
    : role.id === 'dafeiyu' ? '鲸鱼妹暂未配置独立节目音色；画面可用，节目保持静音。'
    : voice === 'voice-failed' ? '龙妹声音准备失败，节目保持静音。请检查本机语音后重新开台。'
    : voice === undefined ? '此环境未接入本机语音运行时。'
    : '';
  const canSwitchScene = typeof bridge?.switchScene === 'function';
  const canChooseScene = editable || (active && canSwitchScene);
  const canChooseRole = !running && !busy && !needsRead && (!bridge || !!saved);
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
    else if (editable && !dirty) void run('start', () => bridge.start(role.id), '本机画面源已开启。');
  }
  const toolbar = <div className="live-toolbar-actions">
    <PetRolePicker label="直播桌宠" options={roles} selected={role} reference={role.reference} description={running ? 'live-role-lock' : undefined}
      onChange={canChooseRole ? id => {
        const next = roles.find(option => option.id === id);
        if (next && !gate.current) {setRole(next);void run('read',()=>bridge!.read(next.id));}
      } : undefined} />
    {appearance}
  </div>;

  return <InteractionLayout page="live" title="直播管理" appearance={toolbar}>
    {!supported ? <section className="interaction-card live-role-unavailable" aria-labelledby="live-role-unavailable-title"><div className="live-output-icon"><PetNookIcon name="lock" /></div><h2 id="live-role-unavailable-title">{role.name}暂不支持直播</h2></section> : <div className="live-stage-layout">
      <section className="interaction-card live-bindings" aria-label="主播实例绑定">
        <label htmlFor="live-role-instance">{role.name}绑定的桌宠实例</label>
        <select id="live-role-instance" value={bindings.bindings[role.id] ?? ''} disabled={!bridge?.writeBinding||bindingBusy||running} onChange={event=>void bindRole(role.id,event.currentTarget.value||null)}>
          <option value="">未绑定</option>
          {instances.filter(item=>item.package.id===role.reference.id&&item.package.version===role.reference.version&&(!bindings.bindings[role.id==='longmei'?'dafeiyu':'longmei']||bindings.bindings[role.id==='longmei'?'dafeiyu':'longmei']!==item.id)).map(item=><option key={item.id} value={item.id}>{item.displayName||item.id}</option>)}
        </select>
        <p role="status">{bindingMessage||'直播只使用这里明确绑定的已登记实例。'}</p>
      </section>
      <section className="interaction-card live-output" aria-labelledby="stage-output-title">
        <header className="live-output-heading">
          <span className="live-output-icon"><PetNookIcon name="live" /></span>
          <h2 id="stage-output-title">舞台输出</h2>
          <span className="live-status" data-state={outputState} role="status">{status}</span>
        </header>
        <div className="live-output-body">
          <ul className="live-output-meta" aria-label="输出规格">
            <li>1920 × 1080</li><li>16:9</li><li><span role="status">{voice === 'ready' ? `${role.name}声音已就绪` : voice === 'preparing' ? `正在准备${role.name}声音…` : '静音'}</span></li><li>本机 OBS 浏览器源</li>
          </ul>
          <div className="live-buttons">
            <button type="button" className="interaction-button primary" aria-disabled={switching || undefined} disabled={!bridge || actionBusy || (!needsRead && !running && (!editable || dirty))} onClick={mainAction}>
              <PetNookIcon name={needsRead ? 'refresh' : running ? 'close' : 'live'} />{primary}
            </button>
            <button type="button" className="interaction-button secondary" aria-disabled={switching || undefined} disabled={!active} onClick={() => void run('preview', () => bridge!.preview(role.id))}><PetNookIcon name="display" />预览舞台</button>
            <button type="button" className="interaction-button secondary" aria-disabled={switching || undefined} disabled={!active} onClick={() => void run('copy', () => bridge!.copy(role.id), '已复制本机 OBS 地址。')}><PetNookIcon name="globe" />复制 OBS 地址</button>
          </div>
          <p className="live-hint live-voice-feedback" role="status">{voiceHint}</p>
          {error || (needsRead && sceneNotice) ? <div className="live-feedback">
            {error && <p role="alert"><PetNookIcon name="warning" />{error}</p>}
            {needsRead && <button type="button" className="interaction-button quiet" disabled={!bridge || !!busy} onClick={() => void run('stop', () => bridge!.stop(role.id), '已关闭本机舞台，请重新读取状态。')}>关闭可能运行的舞台</button>}
          </div> : notice && <p className="live-message" role="status">{notice}</p>}
          {paused && <p className="live-hint">桌宠联动已暂停；解除暂停后可手动开启。</p>}
        </div>
      </section>
      <section className="interaction-card live-scenes-card" aria-labelledby="live-scenes-title">
        <div className="live-section-heading"><span className="live-index" aria-hidden="true">01</span><h2 id="live-scenes-title">布景与摆位</h2></div>
        {running && !canSwitchScene && <p className="live-hint">此版本不支持开台换景。</p>}
        <div className="live-scene-controls">
          <fieldset className="live-scenes">
            <legend className="sr-only">选择布景</legend>
            <div className="live-scene-grid">{liveScenes.map(scene => <div key={scene.id} className="live-scene-option">
              <label className="live-scene-choice">
                <input type="radio" name="live-stage-scene" checked={draft.selected === scene.id} disabled={!canChooseScene} aria-disabled={switching || undefined}
                  onChange={() => selectScene(scene)} />
                <span className="live-scene-art"><img src={artwork(scene.id, 'cover')} alt="" draggable={false} onError={event => { event.currentTarget.hidden = true; }} /></span>
                <span className="live-scene-caption"><strong>{scene.name}</strong>
                  {draft.selected === scene.id ? <small aria-hidden="true"><PetNookIcon name="check" /><span>已选中</span></small> : scene.id === 'desk-room' && <small aria-hidden="true" className="live-scene-default">默认</small>}
                </span>
              </label>
              <button type="button" className="live-scene-preview" aria-label={`预览布景：${scene.name}`} aria-haspopup="dialog" title={`预览${scene.name}`}
                onClick={event => setPreview({ id: scene.id, name: scene.name, opener: event.currentTarget })}>
                <PetNookIcon name="expand" />
              </button>
            </div>)}</div>
          </fieldset>
          <div className="live-adjustments">
            <fieldset className="live-placement" key={draft.selected} disabled={!editable}>
              <legend className="sr-only">角色位置与大小（百分比）</legend>
              <PlacementStepper label="横向位置" min={scene.positionMin} max={scene.positionMax} value={placement.position} onChange={value => update('position', value)} />
              <PlacementStepper label="角色大小" min={75} max={125} value={placement.scale} onChange={value => update('scale', value)} />
            </fieldset>
            <button type="button" className="interaction-button secondary live-save-scene" disabled={!editable || !dirty} onClick={() => void run('save', () => bridge!.save(draft,role.id))}>保存布景</button>
            <p className="live-hint live-scene-status" role="status">{switching ? '正在切换布景…' : running ? sceneNotice || '关闭舞台后可切换桌宠或调整摆位。' : dirty ? '有未保存的修改；先保存布景，再开启直播台。' : ''}</p>
          </div>
        </div>
        {running && <span className="sr-only" id="live-role-lock">关闭舞台后可切换桌宠或调整摆位。</span>}
      </section>
      <section className="interaction-card live-actions-card" aria-labelledby="stage-action-title">
        <div className="live-section-heading"><span className="live-index" aria-hidden="true">02</span><h2 id="stage-action-title">主播互动</h2></div>
        <div className="live-action-list">{orderedActions.map(id => {
          const action=roleActions[id];
          if(!action)return null;
          return <button key={id} type="button" className="interaction-button secondary" aria-disabled={switching || undefined} disabled={!active} onClick={() => void run('trigger', () => bridge!.trigger(id as LiveRoleActionId,role.id))}>
            <PetNookIcon name={actionIcons[id] ?? 'chat'} />{action.label}
          </button>;
        })}</div>
        <LiveDanmaku state={danmaku} notice={danmakuNotice} locked={!!busy}
          available={active && role.id === 'longmei' && voice === 'ready' && !!bridge?.submitDanmaku}
          unavailableHint={running && role.id === 'dafeiyu' ? '鲸鱼妹尚未配置独立节目音色，弹幕演练暂不可用。' : running && !bridge?.submitDanmaku ? '此工作区不支持弹幕演练。' : ''}
          onSend={async text => bridge?.submitDanmaku ? run('submitDanmaku', () => bridge.submitDanmaku!(text,role.id)) : false} />
      </section>
    </div>}
    {supported && preview && <ImagePreview src={artwork(preview.id, 'preview')} alt={preview.name} downloadName={`${preview.name}.webp`}
      returnFocus={preview.opener} onDismiss={() => setPreview(undefined)} />}
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
