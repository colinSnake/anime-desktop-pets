import { chatCompletions } from './chat-completions.ts';
import { responses } from './responses.ts';
import { anthropic } from './anthropic.ts';
import { gemini } from './gemini.ts';
import type { ModelProtocol, ProtocolAdapter } from './types.ts';
/** Explicit registry; never infer a protocol from an endpoint or retry another protocol. */
export const adapters: Readonly<Record<ModelProtocol, ProtocolAdapter>> = Object.freeze({ 'chat-completions': chatCompletions, responses, anthropic, gemini });
