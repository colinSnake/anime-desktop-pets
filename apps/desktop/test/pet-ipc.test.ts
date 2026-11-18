import test from 'node:test';
import assert from 'node:assert/strict';
import { validPetArgs, validPackagePickerArgs } from '../src/pet-ipc.ts';
import { requestPets } from '../src/pet-transport.ts';
test('pet IPC validates exact arity and narrow fixed fields', () => {
 assert.ok(validPetArgs('list', [])); assert.ok(!validPetArgs('list', [{}]));
 assert.ok(validPetArgs('theme', [{expectedRevision:0,theme:'dark'}]));
 assert.ok(!validPetArgs('theme', [{expectedRevision:0,theme:'dark',path:'/secret'}]));
 assert.ok(!validPetArgs('delete', [{expectedRevision:0,id:'pet'}, '/script']));
 assert.ok(!validPetArgs('exec' as never, []));
});
test('package picker IPC is no-argument and cannot accept renderer-selected paths', () => {
 assert.ok(validPackagePickerArgs([]));
 for (const args of [[{}], ['/tmp/anything.petpack'], [[], { recursive: true }]]) assert.ok(!validPackagePickerArgs(args));
});
test('pet transport validates inputs and responses, rejecting private upstream errors', async () => {
 assert.deepEqual(await requestPets({base:'http://127.0.0.1:1',token:'test'}, 'delete', {expectedRevision:0,id:'../x'}), {ok:false,error:'invalid'});
 const original = globalThis.fetch;
 try {
   globalThis.fetch = async () => new Response(JSON.stringify({ok:false,error:'/secret'}),{status:500});
   assert.deepEqual(await requestPets({base:'http://127.0.0.1:1',token:'test'}, 'list'), {ok:false,error:'unavailable'});
   globalThis.fetch = async () => new Response(JSON.stringify({ok:false,error:'conflict'}),{status:409});
   assert.deepEqual(await requestPets({base:'http://127.0.0.1:1',token:'test'}, 'theme',{expectedRevision:0,theme:'dark'}), {ok:false,error:'conflict'});
 } finally { globalThis.fetch = original; }
});
test('instance lifecycle IPC only accepts versioned instance IDs, never source paths or flags', () => {
 for (const method of ['start','stop'] as const) {
  assert.ok(validPetArgs(method,[{expectedRevision:1,id:'pet-one'}]));
  for (const args of [[],[{expectedRevision:1,id:'pet-one'},true],[{expectedRevision:1,id:'pet-one',source:'/private'}],[{expectedRevision:1,id:'../old'}]]) assert.ok(!validPetArgs(method,args));
 }
 assert.ok(validPetArgs('applyDisplay',[{expectedRevision:4,id:'pet-one'}]));
 assert.ok(!validPetArgs('applyDisplay',[{expectedRevision:4,id:'pet-one',size:320}]));
 assert.ok(validPetArgs('visibility',[{expectedRevision:4,id:'pet-one',visible:false}]));
 assert.ok(!validPetArgs('visibility',[{expectedRevision:4,id:'pet-one',visible:false,path:'/private'}]));
});

test('behavior IPC and transport use only the fixed endpoint and bounded instance input', async () => {
 assert.ok(validPetArgs('applyBehavior', [{expectedRevision:1,id:'pet-one'}]));
 for (const args of [[],[{expectedRevision:1,id:'pet-one'},true],[{expectedRevision:1,id:'pet-one',movement:true}],[{expectedRevision:1,id:'pet-one',taskActive:false}]]) assert.ok(!validPetArgs('applyBehavior',args));
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async (url, init)=>{assert.equal(url,'http://127.0.0.1:1/v1/pets/apply-behavior');assert.equal(init?.body,JSON.stringify({expectedRevision:1,id:'pet-one'}));return new Response(JSON.stringify({ok:false,error:'apply-failed'}),{status:503});};
  assert.deepEqual(await requestPets({base:'http://127.0.0.1:1',token:'synthetic'},'applyBehavior',{expectedRevision:1,id:'pet-one'}),{ok:false,error:'apply-failed'});
 } finally {globalThis.fetch=original;}
});
