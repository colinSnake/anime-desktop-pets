import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import { chatIPC } from '../../../packages/contracts/src/online-chat.ts';
import { modelProbeIPC } from '../../../packages/contracts/src/model-probe.ts';
import { MODEL_DISCOVERY_IPC, MODEL_IPC } from '../src/model-ipc.ts';
import { registerWorkspaceModelIPC } from '../src/workspace-model-ipc.ts';

const readable = [chatIPC.list, chatIPC.cancel, MODEL_IPC.list, MODEL_IPC.cancelKeySave,
  MODEL_DISCOVERY_IPC.cancelDiscovery, modelProbeIPC.cancelConnectionTest];
const actions = [chatIPC.send, MODEL_IPC.save, MODEL_IPC.setDefault, MODEL_IPC.remove, MODEL_IPC.prepareKeySave,
  MODEL_DISCOVERY_IPC.discover, modelProbeIPC.testConnection];

function fixture() {
  let trusted = true, visible = false;
  const admissions: boolean[] = [];
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const event = {} as IpcMainInvokeEvent;
  const args = [{ synthetic: true }];
  const invoke = (_method: string, admitted: boolean, forwarded: unknown[]) => {
    assert.deepEqual(forwarded, args);
    admissions.push(admitted);
    return Promise.resolve({ version: 1, ok: false, error: 'unavailable' } as const);
  };
  registerWorkspaceModelIPC((channel, handler) => { handlers.set(channel, handler); }, {
    chat: { invoke }, models: { invoke, invokeDiscovery: invoke, invokeProbe: invoke },
    trusted: (received, forwarded) => {
      assert.equal(received, event);
      assert.deepEqual(forwarded, args);
      return trusted;
    },
    visible: () => visible,
  });
  assert.deepEqual([...handlers.keys()].sort(), [...actions, ...readable].sort());
  return {
    setVisible(value: boolean) { visible = value; }, untrust() { trusted = false; },
    async expect(channels: string[], allowed: boolean) {
      for (const channel of channels) {
        await handlers.get(channel)!(event, ...args);
        assert.deepEqual(admissions.splice(0), [allowed], channel);
      }
    },
  };
}

test('fixed model and chat IPC rejects work arriving after the workspace hides and admits it after reopen', async () => {
  const f = fixture();
  f.setVisible(true);
  await f.expect(actions, true);
  f.setVisible(false);
  await f.expect(actions, false);
  await f.expect(readable, true);
  f.setVisible(true);
  await f.expect(actions, true);
});

test('work requires the first visible frame and an open window never admits an untrusted frame', async () => {
  const f = fixture();
  await f.expect(actions, false);
  f.setVisible(true);
  f.untrust();
  await f.expect([...actions, ...readable], false);
});
