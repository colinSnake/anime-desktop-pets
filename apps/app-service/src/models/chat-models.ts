import { sameChatRoute, type ChatOption, type ChatRoute } from '../../../../packages/contracts/src/online-chat.ts';
import { resolveRoute, routeFor, validateConfiguration } from './config.ts';
import { ModelError } from './errors.ts';
import type { ModelConfiguration } from './types.ts';

export function chatOptions(state: ModelConfiguration): ChatOption[] {
  const { revision, connections, defaultConnectionID } = validateConfiguration(state);
  return connections.flatMap(connection => connection.models.map(model => {
    const { connectionID, modelEntryID, fingerprint, tools, inputModalities } = routeFor(revision, connection, model, 'text-chat');
    return { route: { connectionID, modelEntryID, fingerprint }, connectionName: connection.displayName, modelName: model.displayName,
      // A saved route can be attempted; only the provider response verifies access.
      ready: true, isDefault: connection.id === defaultConnectionID && model.entryID === connection.defaultModelEntryID,
      ...(tools !== 'unsupported' && { taskTools: tools === 'supported' ? true as const : 'unverified' as const }),
      ...(inputModalities && { inputModalities: [...inputModalities] }) };
  }));
}

export function resolveChatRoute(state: ModelConfiguration, selection: ChatRoute) {
  try {
    const route = resolveRoute(state, selection.useDefault ? undefined : selection, 'text-chat');
    if (!sameChatRoute(route, selection)) throw new ModelError('route_changed');
    return route;
  } catch (error) {
    if (error instanceof ModelError && error.code === 'not_configured') throw new ModelError('route_changed');
    throw error;
  }
}
