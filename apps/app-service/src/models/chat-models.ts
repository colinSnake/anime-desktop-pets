import { defaultReasoningEffort, modelReasoningLevels, type ReasoningEffort } from '../../../../packages/contracts/src/model-capabilities.ts';
import { sameChatRoute, type ChatOption, type ChatRoute } from '../../../../packages/contracts/src/online-chat.ts';
import { resolveRoute, routeFor, validateConfiguration } from './config.ts';
import { ModelError } from './errors.ts';
import type { ModelConfiguration } from './types.ts';

// Saved insertion order is the product default. The schema v2 global override
// remains readable for compatibility but never selects a chat/rehearsal route.
function firstSavedChatModel(state: ModelConfiguration) {
  const connection = state.connections[0];
  const model = connection?.models.find(item => item.entryID === connection.defaultModelEntryID);
  return connection && model ? { connection, model } : undefined;
}

export function chatOptions(state: ModelConfiguration): ChatOption[] {
  const configuration = validateConfiguration(state);
  const { revision, connections } = configuration;
  const preferred = firstSavedChatModel(configuration);
  return connections.flatMap(connection => connection.models.map(model => {
    const { connectionID, modelEntryID, fingerprint, tools, inputModalities } = routeFor(revision, connection, model, 'text-chat');
    const reasoningLevels = modelReasoningLevels({ protocol: connection.apiProtocol, baseURL: connection.baseURL, modelID: model.modelID });
    return { ...(reasoningLevels.length ? { reasoningLevels: [...reasoningLevels], reasoningEffort: model.reasoningEffort ?? defaultReasoningEffort(reasoningLevels) } : {}), route: { connectionID, modelEntryID, fingerprint }, connectionName: connection.displayName, modelName: model.displayName,
      // A saved route can be attempted; only the provider response verifies access.
      ready: true, isDefault: connection === preferred?.connection && model === preferred.model,
      ...(tools !== 'unsupported' && { taskTools: tools === 'supported' ? true as const : 'unverified' as const }),
      ...(model.contextWindow !== undefined && { contextWindow: model.contextWindow }),
      ...(inputModalities && { inputModalities: [...inputModalities] }) };
  }));
}

function resolveDefaultChatRoute(state: ModelConfiguration) {
  const configuration = validateConfiguration(state);
  const preferred = firstSavedChatModel(configuration);
  if (!preferred) throw new ModelError('not_configured');
  return routeFor(configuration.revision, preferred.connection, preferred.model, 'text-chat');
}

export function resolveChatRoute(state: ModelConfiguration, selection: ChatRoute, reasoningEffort?: ReasoningEffort) {
  try {
    const route = selection.useDefault ? resolveDefaultChatRoute(state) : resolveRoute(state, selection, 'text-chat');
    if (!sameChatRoute(route, selection)) throw new ModelError('route_changed');
    const levels = modelReasoningLevels({ protocol: route.apiProtocol, baseURL: route.baseURL, modelID: route.modelID });
    if (reasoningEffort !== undefined && !levels.includes(reasoningEffort)) throw new ModelError('invalid_request');
    const effort = reasoningEffort ?? route.reasoningEffort ?? defaultReasoningEffort(levels);
    // Keep the persisted route fingerprint pinned; the explicit choice is frozen per turn.
    return effort === undefined ? route : { ...route, reasoningEffort: effort };
  } catch (error) {
    if (error instanceof ModelError && error.code === 'not_configured') throw new ModelError('route_changed');
    throw error;
  }
}
