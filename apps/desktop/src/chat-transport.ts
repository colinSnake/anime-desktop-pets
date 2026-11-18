import { chatListBytes, chatPaths, chatReplyBytes, chatStatus, isChatListResult, isChatSendResult, validOnlineChatInput, type ChatError, type ChatListResult, type ChatSendResult, type OnlineChatInput } from '../../../packages/contracts/src/online-chat.ts';
import { readBoundedJSON } from './bounded-json.ts';

type Session = { port: number; token: string };
export const chatUnavailable: ChatError = { ok: false, error: 'unavailable' };

async function request(session: Session, action: keyof typeof chatPaths, signal: AbortSignal, input?: OnlineChatInput) {
  const response = await fetch(`http://127.0.0.1:${session.port}${chatPaths[action]}`, {
    method: action === 'list' ? 'GET' : 'POST', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { authorization: `Bearer ${session.token}`, ...(input ? { 'content-type': 'application/json' } : {}) },
    body: input ? JSON.stringify(input) : undefined,
  });
  const result = await readBoundedJSON(response, action === 'list' ? chatListBytes : chatReplyBytes);
  return { status: response.status, result };
}
export async function requestChatModels(session: Session): Promise<ChatListResult> {
  try {
    const { result, status } = await request(session, 'list', AbortSignal.timeout(6000));
    return isChatListResult(result) && status === (result.ok ? 200 : chatStatus[result.error]) ? result : chatUnavailable;
  } catch { return chatUnavailable; }
}
export async function requestOnlineChat(session: Session, input: OnlineChatInput, signal: AbortSignal): Promise<ChatSendResult> {
  if (!validOnlineChatInput(input)) return { ok: false, error: 'invalid_request' };
  const deadline = AbortSignal.timeout(65_000);
  try {
    const { result, status } = await request(session, 'send', AbortSignal.any([deadline, signal]), input);
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    return isChatSendResult(result, input.requestID) && status === (result.ok ? 200 : chatStatus[result.error]) ? result : chatUnavailable;
  } catch { return signal.aborted ? { ok: false, error: 'cancelled' } : deadline.aborted ? { ok: false, error: 'timed_out' } : chatUnavailable; }
}
