import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTaskIPC } from '../src/agent-task-ipc.ts';
import { passwordPasteMenu } from '../src/password-paste-menu.ts';

const taskID = '1f000000-0000-4000-8000-000000000001';
const input = { petID: 'pet-a', taskID };
const task = { ...input, attemptID: '1f000000-0000-4000-8000-000000000002', revision: 1, status: 'queued', phase: 'admitting', progress: 0 };
test('fixed task IPC rejects untrusted windows, path fields, mismatched ownership and hidden replies', async () => {
 let eligible = true, calls = 0, returnedPet = 'pet-b';
 const bridge = new AgentTaskIPC(async () => { calls++; return { ok: true, task: { ...task, petID: returnedPet } }; });
 assert.deepEqual(await bridge.invoke('read', () => false, [input]), { ok: false, error: 'invalid_request' });
 assert.deepEqual(await bridge.invoke('read', () => true, [{ ...input, path: '/private' }]), { ok: false, error: 'invalid_request' });
 assert.equal(calls, 0);
 assert.deepEqual(await bridge.invoke('read', () => true, [input]), { ok: false, error: 'unavailable' });
 returnedPet = input.petID;
 const result = bridge.invoke('read', () => eligible, [input]); eligible = false;
 assert.deepEqual(await result, { ok: false, error: 'unavailable' });
 assert.deepEqual(await bridge.invoke('read', () => true, [input]), { ok: true, task });
});

test('password context menu offers only native paste for an editable trusted password control', () => {
 const details = { formControlType: 'input-password' as const, isEditable: true, editFlags: { canPaste: true } };
 assert.deepEqual(passwordPasteMenu(true, details), [{ role: 'paste', label: '粘贴' }]);
 assert.equal(passwordPasteMenu(false, details), undefined);
 assert.equal(passwordPasteMenu(true, { ...details, formControlType: 'input-text' }), undefined);
 assert.equal(passwordPasteMenu(true, { ...details, isEditable: false }), undefined);
});


test('workspace invalidation aborts the transport of an unacknowledged create', async () => {
 let release!: (value: unknown) => void;
 let owned: AbortSignal | undefined;
 const bridge = new AgentTaskIPC(async (_method, _input, signal?: AbortSignal) => {
  owned = signal;
  return new Promise(resolve => { release = resolve; });
 });
 const creating = bridge.invoke('create', () => true, [{ ...input, prompt: '整理附件', route: { connectionID: 'a', modelEntryID: 'b', fingerprint: 'a'.repeat(64) },
  files: [{ name: 'notes.txt', mediaType: 'text/plain', data: '5L2g5aW9' }] }]);
 try {
  assert.equal(owned?.aborted, false);
  bridge.invalidateCreate();
  assert.equal(owned?.aborted, true);
 } finally { release({ ok: true, task }); }
 assert.deepEqual(await creating, { ok: false, error: 'unavailable' });
});
