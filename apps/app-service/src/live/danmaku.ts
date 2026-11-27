import { isLiveVoiceProfileMutation, type LiveVoiceProfileMutation } from '../../../../packages/contracts/src/live-voice-profile.ts';
import type { LiveVoiceProfileStore } from './voice-profiles.ts';
import type { CharacterLearning } from '../characters/learning.ts';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isLiveDanmaku, isLiveDanmakuReply, isLiveRoleId, isLiveScene } from '../../../../packages/contracts/src/live-stage.ts';
import type { ChatRoute } from '../../../../packages/contracts/src/online-chat.ts';
import { runPiAgent } from '../agent/pi-runtime.ts';
import type { ModelManagement } from '../models/management.ts';
import type { BubbleSpeech } from '../speech/bubble-speech.ts';
import { buildLivePersonaContext, withLivePersonaContext, sameLivePersonaContext, type LivePersonaContext } from './persona-context.ts';
import type {PetWorkspace} from '../pet-workspace.ts';import type {CharacterRepository} from '../characters/repository.ts';import type {LiveRoleBindingStore} from './role-bindings.ts';import type {LiveShareStore} from './sharing.ts';

/** Owned by the trusted service. The OBS listener never registers these routes. */
export function registerLiveDanmaku(app:FastifyInstance,models:ModelManagement|undefined,speech:BubbleSpeech|undefined,allowed:()=>boolean,workspace?:PetWorkspace,characters?:CharacterRepository,bindings?:LiveRoleBindingStore,shares?:LiveShareStore,voices?:LiveVoiceProfileStore,learning?:CharacterLearning){
  type Grant={secret:string;text:string;route:ChatRoute;context:LivePersonaContext;voice:LiveVoiceProfileMutation;timer:ReturnType<typeof setTimeout>};
  let grant: Grant | undefined;
  let inFlight: { abort:AbortController; done:Promise<void> } | undefined;
  let closed = false;
  const round = {longmei:0,dafeiyu:0};
  const starts: number[] = [];
  const clear = () => { if (grant) clearTimeout(grant.timer); grant = undefined; };
  const body = (limit: number) => ({bodyLimit:limit,schema:{querystring:{type:'object',additionalProperties:false}}});
  const ready = () => !closed && allowed();
  const own = (socket: NodeJS.EventEmitter, time: number) => {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    const timer = setTimeout(cancel,time); timer.unref();
    socket.once('close',cancel);
    let done!: () => void;
    inFlight = {abort,done:new Promise<void>(resolve => {done = resolve;})};
    return {signal:abort.signal, current:() => !abort.signal.aborted && ready(), finish:() => {
      socket.removeListener('close',cancel); clearTimeout(timer); inFlight = undefined; done();
    }};
  };
  app.post('/v1/live/danmaku/reply',body(1024),async (req,res) => {
    const data=req.body as {text?:unknown;scene?:unknown;role?:unknown;voice?:unknown}|undefined;
    if(!data||Object.keys(data).length!==4||!isLiveDanmaku(data.text)||!isLiveScene(data.scene)||!isLiveRoleId(data.role)||
      !isLiveVoiceProfileMutation(data.voice)||data.voice.role!==data.role) return res.code(400).send();
    if(!models||!speech||!workspace||!characters||!bindings||!shares||!voices||closed)return res.code(503).send();
    if (!ready() || inFlight) return res.code(409).send();
    const role = data.role;
    const voice = data.voice;
    const {expectedRevision,...target}=voice;
    round[role]++;
    learning?.cancelLive(role);
    const task = own(res.raw,40_000);
    try {
      const scope={workspace,characters,bindings,shares,role:data.role,scene:data.scene,question:data.text};
      const context=await buildLivePersonaContext(scope);
      const model = (await models.listChatModels()).find(option => option.isDefault);
      if (!model) return res.code(412).send();
      if (!task.current() || context.petID !== voice.petID || context.bindingRevision !== voice.bindingRevision) return res.code(409).send();
      const profile = await voices.readForStage(target,task.signal);
      if (!task.current() || !profile.ok || !profile.profile.ready || profile.profile.revision !== expectedRevision) return res.code(409).send();
      const now = performance.now();
      while (starts.length && now - starts[0]! >= 60_000) starts.shift();
      if (starts.length >= 6) return res.code(429).send();
      starts.push(now);
      clear();
      const route: ChatRoute = {...model.route,useDefault:true};
      const text=await runPiAgent({text:data.text,signal:task.signal,acceptReply:part=>isLiveDanmakuReply(part.trim()),system:context.system,
        complete: (input,signal) => models.completeChat(route,async (dispatch,owned) => {
          await withLivePersonaContext(scope,current=>{
            if(owned.aborted||!task.current()||!sameLivePersonaContext(context,current))throw new Error('live_context_changed');
            dispatch(input);
          });
        },signal),
      });
      await models.assertChatRoute(route);
      const published=await withLivePersonaContext(scope,current=>{
        if(!task.current()||!isLiveDanmakuReply(text)||!sameLivePersonaContext(context,current))return false;
        const secret=randomBytes(24).toString('hex');
        const timer=setTimeout(()=>{if(grant?.secret===secret)clear();},10_000);timer.unref();
        grant={secret,text,route,context,voice,timer};
        res.send({ticket:secret,text});return true;
      });
      if(!published)return res.code(503).send();
      return res;
    } catch { return res.code(503).send(); }
    finally { task.finish(); }
  });
  app.post('/v1/live/danmaku/audio',body(96),async (req,res) => {
    const data = req.body as {ticket?:unknown} | undefined;
    if (!data || Object.keys(data).length !== 1 || typeof data.ticket !== 'string' || !/^[a-f0-9]{48}$/.test(data.ticket)) return res.code(400).send();
    if (!models || !speech || !voices || closed) return res.code(503).send();
    if (!ready() || inFlight || !grant || grant.secret !== data.ticket) return res.code(409).send();
    const ownedGrant=grant;const {text,route}=ownedGrant;clear();
    const task = own(res.raw,62_000);
    const {role,petID,bindingRevision,question,scene}=ownedGrant.context;
    const generation=round[role];
    let handle: Awaited<ReturnType<CharacterLearning['issueLiveTurn']>> | undefined;
    let delivered = false;
    try {
      await models.assertChatRoute(route);
      const currentContext=await buildLivePersonaContext({workspace:workspace!,characters:characters!,bindings:bindings!,shares:shares!,role,scene,question});
      if(!task.current()||!sameLivePersonaContext(currentContext,ownedGrant.context))return res.code(409).send();
      const wav = await voices.prepareStageReply(ownedGrant.voice,speech,text,task.signal,ready);
      if (!wav) return res.code(503).send();
      await models.assertChatRoute(route);
      if (learning && task.current()) {
        try {
          handle=await learning.issueLiveTurn({petID,role,bindingRevision,user:question,assistant:text,isCurrent:()=>ready()&&round[role]===generation});
        } catch { /* An ineligible learning round does not prevent otherwise valid audio. */ }
      }
      const published=await withLivePersonaContext({workspace:workspace!,characters:characters!,bindings:bindings!,shares:shares!,role,scene,question},current=>{
        if(!task.current()||!sameLivePersonaContext(current,ownedGrant.context))return false;
        if (handle) res.header('x-adpets-learning-ticket',handle.ticket).header('x-adpets-learning-expires',String(handle.expiresAt));
        res.type('application/octet-stream').send(wav); delivered=true; return true;
      });
      return published?res:res.code(409).send();
    } catch { return res.code(503).send(); }
    finally { if (handle && !delivered) learning?.cancel({petID,ticket:handle.ticket}); task.finish(); }
  });
  return { async close() { closed = true; clear(); const owned = inFlight; owned?.abort.abort(); await owned?.done; } };
}
