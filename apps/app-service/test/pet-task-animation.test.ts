import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlayerSnapshot } from '../../../packages/contracts/src/index.ts';
import type { PetDefinition } from '../../../packages/contracts/src/pets.ts';
import { PetLifecycle } from '../src/pet-lifecycle.ts';
import type { TaskAnimation } from '../src/task-animation.ts';

const pet = (id: string): PetDefinition => ({ id, displayName: id, enabled: true, autoStartOnLaunch: false,
  package: { id: 'local.development.longmei', version: '0.0.0-dev' },
  preferences: { size: 256, hideInFullscreen: true, scheduledActivity: true, movement: true } });
const frame = () => new Promise<void>(resolve => setImmediate(resolve));
const work = (startSerial: number) => ({ state: 'working' as const, activeCount: 1, startSerial });

test('only first-frame-confirmed owned players receive snapshots, and a late join cannot replay an opening', async () => {
  const deliveries: [string, TaskAnimation][] = [];
  const ready = new Map<string, () => void>();
  const lifecycle = new PetLifecycle({ supports: () => true, create: ({ id }) => {
    let status: PlayerSnapshot['status'] = 'stopped';
    const snapshot = (): PlayerSnapshot => ({ kind: 'qt-player', status, detail: '' });
    return { snapshot, start: () => new Promise(resolve => { ready.set(id, () => { status = 'running'; resolve(snapshot()); }); }),
      stop: async () => { status = 'stopped'; return snapshot(); }, close: async () => {},
      applyDisplayPreferences: async () => true, setVisible: async () => true, applyBehaviorPreferences: async () => true,
      applyTaskAnimation: value => { deliveries.push([id, value]); } };
  } });
  const last = (id: string) => deliveries.filter(([tag]) => tag === id).at(-1)?.[1];
  lifecycle.start(pet('a')); ready.get('a')!(); await frame();
  lifecycle.start(pet('b'));
  lifecycle.updateTaskAnimation(work(3));
  assert.equal(last('a')?.startSerial, 3);
  assert.equal(last('b'), undefined);
  ready.get('b')!(); await frame();
  assert.equal(last('b')?.state, 'working');
  assert.equal(last('b')?.startSerial, 0);
  lifecycle.updateTaskAnimation(work(3));
  assert.equal(last('b')?.startSerial, 0);
  lifecycle.updateTaskAnimation(work(4));
  assert.equal(last('a')?.startSerial, 4);
  assert.equal(last('b')?.startSerial, 4);
  lifecycle.stop(pet('a')); await frame();
  lifecycle.updateTaskAnimation(undefined);
  assert.equal(last('a')?.startSerial, 4); // stop owns teardown and is never followed by a new task command.
  assert.equal(last('b')?.state, 'disabled');
  assert.equal(await lifecycle.pauseAll(), true);
  const count = deliveries.length;
  lifecycle.updateTaskAnimation(work(5));
  assert.equal(deliveries.length, count);
  lifecycle.resumeAll(); lifecycle.start(pet('b')); ready.get('b')!(); await frame();
  assert.equal(last('b')?.state, 'disabled');
  await lifecycle.close();
});
