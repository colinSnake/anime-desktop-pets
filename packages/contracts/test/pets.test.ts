import test from 'node:test';
import assert from 'node:assert/strict';
import { isPetInput, isPetResult, isPackageImportResult } from '../src/pets.ts';
test('pet inputs are bounded fixed shapes, not filesystem or execution requests', () => {
  assert.ok(isPetInput('pause', { expectedRevision: 0 }));
  assert.ok(isPetInput('resume', { expectedRevision: 0 }));
  assert.ok(!isPetInput('pause', { expectedRevision: 0, command: 'stop-all' }));
  assert.ok(isPetInput('add', { expectedRevision: 0, package: { id: 'local.pet', version: '1.0.0' } }));
  assert.ok(isPetInput('theme', { expectedRevision: 0, theme: 'system' }));
  for (const value of [{ expectedRevision: -1, theme: 'light' }, { expectedRevision: 1, theme: 'x' }, { expectedRevision: 0, theme: 'light', path: '/private' }]) assert.ok(!isPetInput('theme', value));
  assert.ok(!isPetInput('delete', { expectedRevision: 0, id: '../pet' }));
  assert.ok(isPetInput('applyDisplay', { expectedRevision: 2, id: 'pet-one' }));
  assert.ok(!isPetInput('applyDisplay', { expectedRevision: 2, id: 'pet-one', preferences: { size: 256 } }));
  assert.ok(isPetInput('visibility', { expectedRevision: 2, id: 'pet-one', visible: false }));
  assert.ok(!isPetInput('visibility', { expectedRevision: 2, id: 'pet-one', visible: false, command: 'hide' }));
  assert.ok(!isPetInput('exec' as never, {}));
  assert.ok(!isPetInput('clone', { expectedRevision: 0, id: 'a', extra: true }));
});
test('pet results cannot leak paths or accept pretend runtime metadata', () => {
  assert.ok(isPetResult({ ok: false, error: 'conflict' }));
  assert.ok(!isPetResult({ ok: false, error: '/secret/path' }));
  assert.ok(!isPetResult({ ok: false, error: 'conflict', raw: 'secret' }));
  const data = { revision: 0, theme: 'system', catalog: [], instances: [], maximumRunning: 3, linkage: 'active' };
  assert.ok(isPetResult({ ok: true, workspace: data }));
  assert.ok(!isPetResult({ ok: true, workspace: { ...data, path: '/secret' } }));
});

test('workspace phases are scalar strings and cannot coerce arrays into a valid status', () => {
  const row = { id:'pet', package:{id:'local.pet',version:'1.0.0'}, enabled:true, autoStartOnLaunch:false, preferences:{size:256,scheduledActivity:true,movement:true,hideInFullscreen:true}, phase:['running'] };
  assert.ok(!isPetResult({ok:true, workspace:{revision:0,theme:'system',catalog:[],instances:[row],maximumRunning:3,linkage:'active'}}));
});

test('workspace accepts bounded runtime position feedback only as an explicit volatile status', () => {
  const row = { id: 'pet', package: { id: 'local.pet', version: '1.0.0' }, enabled: true, autoStartOnLaunch: false,
    preferences: { size: 256, scheduledActivity: true, movement: true, hideInFullscreen: true, x: 10, y: 20 }, phase: 'running',
    positionFeedback: { x: 30, y: 40, status: 'saved' } };
  const workspace = { revision: 1, theme: 'system', catalog: [], instances: [row], maximumRunning: 3, linkage: 'active' };
  assert.ok(isPetResult({ ok: true, workspace }));
  assert.ok(!isPetResult({ ok: true, workspace: { ...workspace, instances: [{ ...row, positionFeedback: { x: 30, y: 40, status: 'success' } }] } }));
  assert.ok(!isPetResult({ ok: true, workspace: { ...workspace, instances: [{ ...row, positionFeedback: { x: 1_000_001, y: 40, status: 'saved' } }] } }));
});

test('behavior apply accepts only a revision and instance ID; runtime feedback is explicit and bounded', () => {
 assert.ok(isPetInput('applyBehavior', {expectedRevision: 2, id: 'pet-one'}));
 for (const extra of [{movement:true}, {path:'/private'}, {taskActive:false}, {paused:false}])
  assert.ok(!isPetInput('applyBehavior', {expectedRevision:2,id:'pet-one',...extra}));
 const row={id:'pet',package:{id:'local.pet',version:'1.0.0'},enabled:true,autoStartOnLaunch:false,preferences:{size:256,scheduledActivity:true,movement:true,hideInFullscreen:true},phase:'running'};
 const result=(behavior:unknown)=>({ok:true,workspace:{revision:1,theme:'system',catalog:[],maximumRunning:3,linkage:'active',instances:[{...row,behavior}]}});
 assert.ok(isPetResult(result({status:'applied',scheduledActivity:true,movement:false})));
 assert.ok(isPetResult(result({status:'failed'})));
 for (const value of [{status:'applied',scheduledActivity:true},{status:'applied',scheduledActivity:1,movement:true},{status:'failed',movement:true},{status:'applied',scheduledActivity:true,movement:true,taskActive:false}]) assert.ok(!isPetResult(result(value)));
});

test('package import feedback is bounded metadata and never carries source paths', () => {
  const valid = { ok: true, items: [
    { name: '小崽.petpack', status: 'added', package: { id: 'local.pet', version: '1.0.0' } },
    { name: 'bad.petpack', status: 'failed' },
  ] };
  assert.ok(isPackageImportResult(valid));
  for (const invalid of [
    { ...valid, path: '/private/source.petpack' },
    { ok: true, items: [{ name: '../secret', status: 'failed' }] },
    { ok: true, items: [{ name: 'pet', status: 'added', package: { id: 'local.pet', version: '1.0.0' }, path: '/tmp/x' }] },
    { ok: true, items: Array.from({ length: 17 }, (_, i) => ({ name: `p${i}`, status: 'failed' })) },
  ]) assert.ok(!isPackageImportResult(invalid));
});
