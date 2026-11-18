import { isChatListResult, isChatSendResult, validChatRequestID, validOnlineChatInput, type ChatListResult, type ChatSendResult, type OnlineChatInput } from '../../../packages/contracts/src/online-chat.ts';

const invalid = { ok: false, error: 'invalid_request' } as const;
const unavailable = { ok: false, error: 'unavailable' } as const;
const cancelled = { ok: false, error: 'cancelled' } as const;

export class ChatIPC {
  private active?: { id: string; abort: AbortController };
  private listing = false;
  constructor(private readonly service: {
    listChatModels(): Promise<ChatListResult>;
    sendOnlineChat(input: OnlineChatInput, signal: AbortSignal): Promise<ChatSendResult>;
  }) {}
  cancel() {
    const active = this.active;
    this.active = undefined;
    active?.abort.abort();
  }
  async invoke(method: 'list' | 'send' | 'cancel', trusted: boolean, args: unknown[]) {
    if (!trusted) return invalid;
    if (method === 'list') {
      if (args.length) return invalid;
      if (this.listing) return { ok: false, error: 'busy' } as const;
      this.listing = true;
      try {
        const result = await this.service.listChatModels();
        return isChatListResult(result) ? result : unavailable;
      } catch { return unavailable; }
      finally { this.listing = false; }
    }
    if (args.length !== 1) return invalid;
    const [input] = args;
    if (method === 'cancel') {
      if (!validChatRequestID(input)) return invalid;
      if (this.active?.id === input) this.cancel();
      return;
    }
    if (!validOnlineChatInput(input)) return invalid;
    if (this.active) return { ok: false, error: 'busy' } as const;
    const active = { id: input.requestID, abort: new AbortController() };
    this.active = active;
    try {
      const result = await this.service.sendOnlineChat(input, active.abort.signal);
      if (this.active !== active) return cancelled;
      return isChatSendResult(result, active.id) ? result : unavailable;
    } catch { return active.abort.signal.aborted ? cancelled : unavailable; }
    finally { if (this.active === active) this.active = undefined; }
  }
}
