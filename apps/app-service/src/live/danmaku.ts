import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isLiveDanmaku, isLiveDanmakuReply, isLiveRoleId, isLiveScene, type LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';
import type { ChatRoute } from '../../../../packages/contracts/src/online-chat.ts';
import { runPiAgent } from '../agent/pi-runtime.ts';
import type { ModelManagement } from '../models/management.ts';
import type { BubbleSpeech } from '../speech/bubble-speech.ts';
import { buildLivePersonaContext } from './persona-context.ts';
import type {PetWorkspace} from '../pet-workspace.ts';import type {CharacterRepository} from '../characters/repository.ts';import type {LiveRoleBindingStore} from './role-bindings.ts';import type {LiveShareStore} from './sharing.ts';

/** Owned by the trusted service. The OBS listener never registers these routes. */
export function registerLiveDanmaku(app:FastifyInstance,models:ModelManagement|undefined,speech:BubbleSpeech|undefined,allowed:()=>boolean,workspace?:PetWorkspace,characters?:CharacterRepository,bindings?:LiveRoleBindingStore,shares?:LiveShareStore){
  type Grant={secret:string;text:string;route:ChatRoute;role:LiveRoleId;scene:import('../../../../packages/contracts/src/live-stage.ts').LiveScene;question:string;system:string;petID:string;timer:ReturnType<typeof setTimeout>};
  let grant: Grant | undefined;
  let inFlight: { abort:AbortController; done:Promise<void> } | undefined;
  let closed = false;
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
    const data=req.body as {text?:unknown;scene?:unknown;role?:unknown}|undefined;
    if(!data||Object.keys(data).length!==3||!isLiveDanmaku(data.text)||!isLiveScene(data.scene)||!isLiveRoleId(data.role)) return res.code(400).send();
    if(!models||!speech||!workspace||!characters||!bindings||!shares||closed)return res.code(503).send();
    if (!ready() || inFlight) return res.code(409).send();
    const task = own(res.raw,40_000);
    try {
      const context=await buildLivePersonaContext({workspace,characters,bindings,shares,role:data.role,scene:data.scene,question:data.text});
      const model = (await models.listChatModels()).find(option => option.isDefault);
      if (!model) return res.code(412).send();
      if (!task.current()) return res.code(409).send();
      const now = performance.now();
      while (starts.length && now - starts[0]! >= 60_000) starts.shift();
      if (starts.length >= 6) return res.code(429).send();
      starts.push(now);
      clear();
      const route: ChatRoute = {...model.route,useDefault:true};
      const text=await runPiAgent({text:data.text,signal:task.signal,acceptReply:part=>isLiveDanmakuReply(part.trim()),system:context.system,
        complete: (input,signal) => models.completeChat(route,async (dispatch,owned) => {
          if (owned.aborted || !task.current()) return;
          dispatch(input);
        },signal),
      });
      await models.assertChatRoute(route);
      if (!task.current() || !isLiveDanmakuReply(text)) return res.code(503).send();
      const secret = randomBytes(24).toString('hex');
      const timer = setTimeout(() => { if (grant?.secret === secret) clear(); },10_000); timer.unref();
      grant={secret,text,route,role:data.role,scene:data.scene,question:data.text,system:context.system,petID:context.petID,timer};
      return res.send({ticket:secret,text});
    } catch { return res.code(503).send(); }
    finally { task.finish(); }
  });
  app.post('/v1/live/danmaku/audio',body(96),async (req,res) => {
    const data = req.body as {ticket?:unknown} | undefined;
    if (!data || Object.keys(data).length !== 1 || typeof data.ticket !== 'string' || !/^[a-f0-9]{48}$/.test(data.ticket)) return res.code(400).send();
    if (!models || !speech || closed) return res.code(503).send();
    if (!ready() || inFlight || !grant || grant.secret !== data.ticket) return res.code(409).send();
    const ownedGrant=grant;const {text,route}=ownedGrant;clear();
    const task = own(res.raw,62_000);
    try {
      await models.assertChatRoute(route);
      const currentContext=await buildLivePersonaContext({workspace:workspace!,characters:characters!,bindings:bindings!,shares:shares!,role:ownedGrant.role,scene:ownedGrant.scene,question:ownedGrant.question});
      if(!task.current()||currentContext.petID!==ownedGrant.petID||currentContext.system!==ownedGrant.system)return res.code(409).send();
      const wav = await speech.prepareStageReply(text,task.signal,ready);
      if (!wav) return res.code(503).send();
      await models.assertChatRoute(route);
      const finalContext=await buildLivePersonaContext({workspace:workspace!,characters:characters!,bindings:bindings!,shares:shares!,role:ownedGrant.role,scene:ownedGrant.scene,question:ownedGrant.question});
      if(!task.current()||finalContext.petID!==ownedGrant.petID||finalContext.system!==ownedGrant.system)return res.code(409).send();
      return res.type('application/octet-stream').send(wav);
    } catch { return res.code(503).send(); }
    finally { task.finish(); }
  });
  return { async close() { closed = true; clear(); const owned = inFlight; owned?.abort.abort(); await owned?.done; } };
}
