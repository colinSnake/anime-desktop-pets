import { isHistoryInput, isHistoryResult, type ChatHistoryMethod } from '../../../packages/contracts/src/chat-history.ts';
import { isChatListResult, isChatSendResult, isMaterialApprovalInput, isMaterialApprovalResult, type ChatMaterialApprovalResult, validChatRequestID, validOnlineChatInput, type ChatListResult, type ChatSendResult, type OnlineChatInput } from '../../../packages/contracts/src/online-chat.ts';

const invalid = { ok: false, error: 'invalid_request' } as const;
const unavailable = { ok: false, error: 'unavailable' } as const;
const cancelled = { ok: false, error: 'cancelled' } as const;

export class ChatIPC {
  private active?: { id: string; abort: AbortController };
  private listing = false;
  private permit?: { id: string; grant: string };
  private approving?: { id: string; abort: AbortController };
  constructor(private readonly service: {
    chatHistory?(method: ChatHistoryMethod, input: unknown): Promise<unknown>;
    approveChatMaterials?(input: OnlineChatInput, signal: AbortSignal): Promise<ChatMaterialApprovalResult>;
    listChatModels(): Promise<ChatListResult>;
    sendOnlineChat(input: OnlineChatInput, signal: AbortSignal): Promise<ChatSendResult>;
  }) {}
  cancel() {
    const active = this.active;
    this.active = undefined;
    active?.abort.abort();
    this.approving?.abort.abort();
    this.permit = undefined;
  }
  async approveMaterials(eligible: () => boolean, args: unknown[]): Promise<ChatMaterialApprovalResult> {
    const [input] = args;
    if (!eligible() || args.length !== 1 || !isMaterialApprovalInput(input)) return invalid;
    if (!this.service.approveChatMaterials) return unavailable;
    if (this.approving || this.active) return { ok: false, error: 'busy' };
    this.permit = undefined;
    const owned = { id: input.requestID, abort: new AbortController() };
    this.approving = owned;
    try {
      const result = await this.service.approveChatMaterials(input, owned.abort.signal);
      if (!eligible() || owned.abort.signal.aborted || !isMaterialApprovalResult(result)) return cancelled;
      if (result.ok) this.permit = { id: input.requestID, grant: result.grant };
      return result;
    } catch { return unavailable; }
    finally { this.approving = undefined; }
  }
  private historyPending = false;
  async invokeHistory(method: ChatHistoryMethod, eligible: () => boolean, args: unknown[]) {
    const [input] = args;
    if (!eligible() || args.length !== 1 || !isHistoryInput(method, input)) return invalid;
    if (!this.service.chatHistory) return unavailable;
    if (this.historyPending) return { ok: false, error: 'busy' } as const;
    this.historyPending = true;
    try {
      const result = await this.service.chatHistory(method, input);
      // Never return a private history page to a renderer that hid/navigated during the read.
      if (!eligible()) return unavailable;
      return isHistoryResult(method, input, result) ? result : unavailable;
    } catch { return unavailable; }
    finally { this.historyPending = false; }
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
      if (this.active?.id === input || this.approving?.id === input || this.permit?.id === input) this.cancel();
      return;
    }
    if (!validOnlineChatInput(input)) return invalid;
    if (this.active || this.approving) return { ok: false, error: 'busy' } as const;
    if (input.attachments?.length && (!this.permit || this.permit.id !== input.requestID || this.permit.grant !== input.materialGrant)) return { ok: false, error: 'approval_required' } as const;
    this.permit = undefined;
    const active = { id: input.requestID, abort: new AbortController() };
    this.active = active;
    try {
      const result = await this.service.sendOnlineChat(input, active.abort.signal);
      if (this.active !== active) return cancelled;
      if (!isChatSendResult(result, active.id)) return unavailable;
      return result;
    } catch { return active.abort.signal.aborted ? cancelled : unavailable; }
    finally { if (this.active === active) this.active = undefined; }
  }
}
