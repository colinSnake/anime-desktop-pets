import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlayerSnapshot } from '../../../packages/contracts/src/index.ts';
import type { PetDefinition } from '../../../packages/contracts/src/pets.ts';
import { PetLifecycle } from '../src/pet-lifecycle.ts';
import { defaultPreferences } from '../src/pet-registry.ts';
const pet = (id = 'pet-one'): PetDefinition => ({ id, package: {id:'local.dev',version:'0.0.0-dev'}, enabled:true, autoStartOnLaunch:true, preferences:defaultPreferences() });
function player() {
 let status: PlayerSnapshot['status'] = 'stopped';
 let ready!: () => void; let stopped!: () => void;
 const calls: string[] = [];
 const snapshot = (): PlayerSnapshot => ({ kind:'qt-player', status, detail:'synthetic' });
 const controller = {
  snapshot,
  start() { calls.push('start'); status='starting'; return new Promise<PlayerSnapshot>(resolve => { ready=() => { status='running'; resolve(snapshot()); }; }); },
  stop() { calls.push('stop'); status='stopping'; return new Promise<PlayerSnapshot>(resolve => { stopped=() => { status='stopped'; resolve(snapshot()); }; }); },
  async applyDisplayPreferences(value: {size:number;hideInFullscreen:boolean}) { calls.push(`apply:${value.size}:${value.hideInFullscreen}`); return status==='running'; },
  async applyBehaviorPreferences() { return status==='running'; },
  async setVisible(visible: boolean) { calls.push(`visible:${visible}`); return status==='running'; },
  async close() { calls.push('close'); status='stopped'; },
 };
 return { controller, calls, ready:() => ready(), stopped:() => stopped(), fail:() => {status='error';} };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('listing eligibility never creates or auto-starts a runtime; unsupported reference stays disconnected', async () => {
 let creations=0;
 const life = new PetLifecycle({ supports:p => p.package.id === 'local.dev', create:() => {creations++; return player().controller;} });
 assert.equal(life.phase(pet()),'stopped'); assert.equal(creations,0);
 assert.equal(life.phase({...pet(),package:{id:'other',version:'1.0.0'}}),'not-connected');
 assert.equal(life.start({...pet(),enabled:false}),'invalid'); assert.equal(creations,0);
 await life.close(); assert.equal(life.start(pet()),'unavailable');
});
test('three slots include starting/stopping/failed; each ID owns only its controller', async () => {
 const players = new Map<string,ReturnType<typeof player>>();
 const life = new PetLifecycle({supports:()=>true,create:p => {const own=player();players.set(p.id,own);return own.controller;}});
 for (const id of ['a','b','c']) assert.equal(life.start(pet(id)),undefined);
 assert.equal(life.start(pet('d')),'limit');
 assert.equal(life.start(pet('a')),undefined); assert.deepEqual(players.get('a')!.calls,['start']);
 players.get('a')!.ready(); await settle(); assert.equal(life.phase(pet('a')),'running');
 players.get('a')!.fail(); assert.equal(life.phase(pet('a')),'failed');
 assert.equal(life.start(pet('a')),'active'); assert.equal(life.start(pet('d')),'limit');
 assert.equal(life.stop(pet('a')),undefined); assert.equal(life.phase(pet('a')),'stopping');
 assert.equal(life.start(pet('d')),'limit'); players.get('a')!.stopped(); await settle();
 assert.equal(life.phase(pet('a')),'stopped'); assert.equal(life.start(pet('d')),undefined);
 assert.deepEqual(players.get('b')!.calls,['start']); await life.close();
});
test('stop can cancel starting without awaiting first frame; stale start completion cannot overwrite stopping', async () => {
 const own=player(); const life=new PetLifecycle({supports:()=>true,create:()=>own.controller});
 life.start(pet()); life.stop(pet()); own.ready(); await settle();
 assert.equal(life.phase(pet()),'stopping'); assert.equal(life.start(pet()),'busy');
 own.stopped(); await settle(); assert.equal(life.phase(pet()),'stopped'); await life.close();
});
test('rejection remains failed and shutdown tries every owner even if one close throws synchronously', async () => {
 let closed=0;
 const life=new PetLifecycle({supports:()=>true,create:p => ({snapshot:()=>({kind:'qt-player',status:'stopped',detail:''}),start:async()=>{throw Error('/private');},stop:async()=>{throw Error('/private');},applyDisplayPreferences:async()=>false,applyBehaviorPreferences:async()=>false,setVisible:async()=>false,close:()=>{closed++;if(p.id==='a')throw Error('/private');return Promise.resolve();}})});
 life.start(pet('a'));life.start(pet('b'));await settle();
 assert.equal(life.phase(pet('a')),'failed');life.stop(pet('a'));await settle();assert.equal(life.phase(pet('a')),'failed');
 await assert.rejects(life.close(),/instance_cleanup_failed/); assert.equal(closed,2);
 assert.equal(life.start(pet('c')),'unavailable');
});

test('display preferences apply only to the addressed running owner and update its volatile confirmation', async () => {
 const one=player(), two=player();
 const configured={...pet('one'),preferences:{...defaultPreferences(),size:320,hideInFullscreen:false}};
 const life=new PetLifecycle({supports:()=>true,create:p=>p.id==='one'?one.controller:two.controller});
 life.start(configured); life.start(pet('two')); one.ready(); two.ready();
 await settle();
 const result=await life.applyDisplayPreferences(configured);
 assert.equal(result,undefined); assert.deepEqual(life.applied(pet('one')),{size:320,hideInFullscreen:false,visible:true});
 assert.deepEqual(life.applied(pet('two')),{size:256,hideInFullscreen:true,visible:true});
 await life.setVisible(configured,false);
 assert.deepEqual(one.calls,['start','apply:320:false','visible:false']);
 assert.deepEqual(life.applied(configured),{size:320,hideInFullscreen:false,visible:false});
 await life.close();
});

test('display application failure leaves the prior runtime confirmation unchanged', async () => {
 const own=player();
 const controller={...own.controller,applyDisplayPreferences:async()=>{throw Error('private');},setVisible:async()=>false};
 const life=new PetLifecycle({supports:()=>true,create:()=>controller});
 life.start(pet()); own.ready(); await settle();
 assert.equal(await life.applyDisplayPreferences(pet()),'apply-failed');
 assert.deepEqual(life.applied(pet()),{size:256,hideInFullscreen:true,visible:true});
 await life.close();
});

test('behavior confirmation follows first frame, addresses one owner, and uses latest preferences on restart', async () => {
 const one=player(),two=player();const starts:unknown[]=[];const applications:unknown[]=[];
 const life=new PetLifecycle({supports:()=>true,create:p=>p.id==='one'?{...one.controller,start:(preferences)=>{starts.push(structuredClone(preferences));return one.controller.start();},applyBehaviorPreferences:async value=>{applications.push(value);return true;}}:{...two.controller,applyBehaviorPreferences:async()=>{throw Error('wrong owner');}}});
 const configured=pet('one');configured.preferences.scheduledActivity=false;
 life.start(configured);life.start(pet('two'));
 assert.equal(life.behavior(configured),undefined);
 one.ready();two.ready();await settle();
 assert.deepEqual(life.behavior(configured),{status:'applied',scheduledActivity:false,movement:true});
 const changed={...configured,preferences:{...configured.preferences,scheduledActivity:true,movement:false}};
 assert.equal(await life.applyBehaviorPreferences(changed),undefined);
 assert.deepEqual(applications,[{scheduledActivity:true,movement:false}]);
 assert.deepEqual(life.behavior(pet('two')),{status:'applied',scheduledActivity:true,movement:true});
 life.stop(configured);one.stopped();await settle();assert.equal(life.behavior(configured),undefined);
 life.start(changed);one.ready();await settle();
 assert.deepEqual(starts.map(p=>(p as {movement:boolean}).movement),[true,false]);
 assert.deepEqual(life.behavior(changed),{status:'applied',scheduledActivity:true,movement:false});
 await life.close();
});
test('failed behavior apply is not confirmation, and late apply cannot resurrect stopped or closing state', async () => {
 const own=player();let finish!:(value:boolean)=>void;
 const life=new PetLifecycle({supports:()=>true,create:()=>({...own.controller,applyBehaviorPreferences:()=>new Promise<boolean>(r=>{finish=r;})})});
 assert.equal(await life.applyBehaviorPreferences(pet()),'active');
 life.start(pet());own.ready();await settle();
 const failed=life.applyBehaviorPreferences(pet());finish(false);assert.equal(await failed,'apply-failed');
 assert.deepEqual(life.behavior(pet()),{status:'failed'});
 const late=life.applyBehaviorPreferences(pet());life.stop(pet());own.stopped();await settle();finish(true);
 assert.equal(await late,'apply-failed');assert.equal(life.behavior(pet()),undefined);
 await life.close();assert.equal(await life.applyBehaviorPreferences(pet()),'unavailable');
});

test('self-stop, new startup, failure and close invalidate the previous session behavior confirmation', async () => {
 const own=player();let failStart=false;
 const life=new PetLifecycle({supports:()=>true,create:()=>({...own.controller,start:()=>own.controller.start().then(result=>failStart?{...result,status:'error' as const}:result)})});
 life.start(pet());own.ready();await settle();assert.equal(life.behavior(pet())?.status,'applied');
 // A menu/EOF stop changes the owned controller without calling lifecycle.stop.
 await own.controller.close();assert.equal(life.phase(pet()),'stopped');
 assert.equal(life.behavior(pet()),undefined);
 const changed={...pet(),preferences:{...pet().preferences,movement:false}};
 failStart=true;life.start(changed);assert.equal(life.behavior(changed),undefined);
 own.ready();await settle();assert.equal(life.phase(changed),'failed');assert.equal(life.behavior(changed),undefined);
 await life.close();assert.equal(life.behavior(changed),undefined);
});

test('pause closes the start gate before stopping every owned runtime and resume never auto-starts', async () => {
 const owners=new Map<string,ReturnType<typeof player>>();
 const life=new PetLifecycle({supports:()=>true,create:p=>{const own=player();owners.set(p.id,own);return own.controller;}});
 life.start(pet('one'));life.start(pet('two'));
 const paused=life.pauseAll();
 assert.equal(life.start(pet('three')),'busy');
 assert.equal(owners.get('one')!.calls.at(-1),'stop');
 assert.equal(owners.get('two')!.calls.at(-1),'stop');
 owners.get('one')!.stopped();owners.get('two')!.stopped();
 assert.equal(await paused,true);
 assert.equal(life.phase(pet('one')),'stopped');
 life.resumeAll();
 assert.equal(life.phase(pet('one')),'stopped');
 assert.equal(owners.get('one')!.calls.filter(call=>call==='start').length,1);
 assert.equal(life.start(pet('one')),undefined);
 await life.close();
});

test('unconfirmed pause stop keeps its runtime failed and consumes the owned slot', async () => {
 const own=player();
 const life=new PetLifecycle({supports:()=>true,create:()=>({...own.controller,stop:async()=>({kind:'qt-player',status:'error',detail:'synthetic'})})});
 life.start(pet());own.ready();await settle();
 assert.equal(await life.pauseAll(),false);
 assert.equal(life.phase(pet()),'failed');
 assert.equal(life.start(pet('other')),'busy');
 life.resumeAll();
 assert.equal(life.phase(pet()),'failed');
 await life.close();
});
