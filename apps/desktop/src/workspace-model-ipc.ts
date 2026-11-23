import type { IpcMainInvokeEvent } from 'electron';
import { chatHistoryIPC } from '../../../packages/contracts/src/chat-history.ts';
import { chatIPC } from '../../../packages/contracts/src/online-chat.ts';
import { modelProbeIPC } from '../../../packages/contracts/src/model-probe.ts';
import type { ChatIPC } from './chat-ipc.ts';
import { MODEL_DISCOVERY_IPC, MODEL_IPC, type ModelIPC } from './model-ipc.ts';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

type Access = {
  chat: Pick<ChatIPC, 'invoke'>;
  history?: Pick<ChatIPC, 'invokeHistory'>;
  models: Pick<ModelIPC, 'invoke' | 'invokeProbe' | 'invokeDiscovery'>;
  trusted(event: IpcMainInvokeEvent, args: unknown[]): boolean;
  visible(): boolean;
};

export function registerWorkspaceModelIPC(handle: (channel: string, listener: Handler) => void,
  { chat, history, models, trusted, visible }: Access): void {
  // The same trusted renderer survives a tray close. Check visibility for every new action.
  const admit = (event: IpcMainInvokeEvent, args: unknown[], passive: boolean) =>
    trusted(event, args) && (passive || visible());
  for (const method of Object.keys(chatIPC) as (keyof typeof chatIPC)[])
    handle(chatIPC[method], (event, ...args) => chat.invoke(method, admit(event, args, method === 'list' || method === 'cancel'), args));
  if (history) for (const method of ['list', 'detail', 'clear'] as const)
    handle(chatHistoryIPC[method], (event, ...args) => history.invokeHistory(method, () => admit(event, args, false), args));
  for (const method of Object.keys(MODEL_IPC) as (keyof typeof MODEL_IPC)[])
    handle(MODEL_IPC[method], (event, ...args) => models.invoke(method, admit(event, args, method === 'list'), args));
  for (const method of Object.keys(modelProbeIPC) as (keyof typeof modelProbeIPC)[])
    handle(modelProbeIPC[method], (event, ...args) => models.invokeProbe(method, admit(event, args, method === 'cancelConnectionTest'), args));
  for (const method of Object.keys(MODEL_DISCOVERY_IPC) as (keyof typeof MODEL_DISCOVERY_IPC)[])
    handle(MODEL_DISCOVERY_IPC[method], (event, ...args) => models.invokeDiscovery(method, admit(event, args, method === 'cancelDiscovery'), args));
}
