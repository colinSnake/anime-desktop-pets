import assert from 'node:assert/strict';
import test from 'node:test';
import { dafeiyu, longmei } from '../src/built-in-pets.ts';
import { identityFields, isIdentityDraft } from '../src/characters.ts';
import { characterPersonaSuggestions, liveRoleForPackage, liveRolePackages } from '../src/character-personas.ts';
import { isLiveRoleAction, isLiveSnapshot, liveRoleActions } from '../src/live-stage.ts';

test('built-in live personas provide complete, valid, distinct identity suggestions', () => {
  for (const role of ['longmei', 'dafeiyu'] as const) {
    const suggestion = characterPersonaSuggestions[role];
    assert.equal(suggestion.name, role === 'longmei' ? '龙妹' : '鲸鱼妹');
    assert.deepEqual(Object.keys(suggestion).sort(), ['name', ...identityFields].sort());
    assert.ok(identityFields.every(field => suggestion[field].trim().length > 0), `${role} has every identity section`);
    assert.equal(isIdentityDraft(suggestion), true);
  }
  assert.notEqual(characterPersonaSuggestions.longmei.personality, characterPersonaSuggestions.dafeiyu.personality);
  assert.notEqual(characterPersonaSuggestions.longmei.speakingStyle, characterPersonaSuggestions.dafeiyu.speakingStyle);
  assert.equal('memories' in characterPersonaSuggestions.longmei, false);
  assert.equal('chatShare' in characterPersonaSuggestions.longmei, false);
});

test('live role package matching is exact and rejects cross-role or changed package versions', () => {
  assert.deepEqual(liveRolePackages.longmei, longmei);
  assert.deepEqual(liveRolePackages.dafeiyu, dafeiyu);
  assert.equal(liveRoleForPackage(longmei), 'longmei');
  assert.equal(liveRoleForPackage(dafeiyu), 'dafeiyu');
  assert.equal(liveRoleForPackage({ ...dafeiyu, version: 'other-version' }), undefined);
  assert.equal(liveRoleForPackage({ ...longmei, id: 'unknown-pet' }), undefined);
  assert.equal(liveRoleForPackage({ ...longmei, extra: true }), undefined);
});

test('live action catalogs are role-scoped and cannot cross-play another pet actions', () => {
  assert.deepEqual(Object.keys(liveRoleActions.longmei).sort(), ['01', '18', '20']);
  assert.deepEqual(Object.keys(liveRoleActions.dafeiyu), ['companion-wave', 'companion-jump', 'companion-49c0d89c0992']);
  for (const action of Object.keys(liveRoleActions.longmei)) assert.equal(isLiveRoleAction('longmei', action), true);
  for (const action of Object.keys(liveRoleActions.dafeiyu)) assert.equal(isLiveRoleAction('dafeiyu', action), true);
  assert.equal(isLiveRoleAction('dafeiyu', '01'), false);
  assert.equal(isLiveRoleAction('longmei', 'companion-wave'), false);
  assert.equal(isLiveRoleAction('longmei', '__proto__'), false);
  assert.equal(isLiveRoleAction('unknown', '01'), false);
});

test('live stage snapshots bind each action and voice cue to one presenter role', () => {
  const base = { protocol:1, scene:'desk-room', placement:{position:50,scale:100}, generation:1 };
  assert.equal(isLiveSnapshot({...base,role:'dafeiyu',action:'companion-wave',remainingMs:2000}),true);
  assert.equal(isLiveSnapshot({...base,role:'longmei',action:'01',remainingMs:2000}),true);
  assert.equal(isLiveSnapshot({...base,role:'dafeiyu',action:'01',remainingMs:2000}),false);
  assert.equal(isLiveSnapshot({...base,role:'longmei',action:'companion-wave',remainingMs:2000}),false);
  assert.equal(isLiveSnapshot({...base,role:'dafeiyu',action:'companion-wave',remainingMs:2000,voice:true}),false);
  assert.equal(isLiveSnapshot({...base,role:'dafeiyu',voice:true}),false);
  assert.equal(isLiveSnapshot({...base,role:'longmei',voice:true}),false);
  assert.equal(isLiveSnapshot(base),false);
});
