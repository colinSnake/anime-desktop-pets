import type { ChatWorkspaceState } from './chat-session.ts';
import { textDraft } from './chat-draft.ts';

export const emptyChatState: ChatWorkspaceState = { characters: [], models: [], available: false, localAvailable: false, detachedDrafts: [],
 session: { draft: '', draftSnapshot: textDraft(''), turns: [], pending: false, failed: false, status: '', confirmingClear: false } };
