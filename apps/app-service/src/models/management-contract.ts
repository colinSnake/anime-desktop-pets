/** Private main ↔ utility process contract. Not exported by packages/contracts. */
import { validateConfiguration } from './config.ts';
import type { CredentialChange } from './repository.ts';
import { MODEL_MANAGEMENT_ERRORS, validModelAPIKey, type ModelCleanup, type ModelDefault, type ModelEdit, type ModelManagementFailure, type ModelManagementReply, type ModelRemove } from '../../../../packages/contracts/src/models.ts';
export type { ModelManagementReply, SavedModelConfiguration } from '../../../../packages/contracts/src/models.ts';

export const MODEL_MANAGEMENT_VERSION = 1;
export const MODEL_MANAGEMENT_PATHS = { list: '/v1/models', save: '/v1/models/save', default: '/v1/models/default', remove: '/v1/models/remove' } as const;
export const MODEL_BODY_LIMIT = 64 * 1024;
export const MODEL_RESPONSE_LIMIT = 1_048_576 + 64 * 1024;
export type ModelAction = keyof typeof MODEL_MANAGEMENT_PATHS;
export type ModelInputs = {
  list: undefined;
  save: ModelEdit & { credential: CredentialChange };
  default: ModelDefault;
  remove: ModelRemove;
};
export type ModelBridgeResult = ModelManagementReply | { version: 1; ok: false; error: 'write_outcome_unknown' };
export const modelStatus = (result: ModelManagementReply) => result.ok ? 200 : result.error === 'invalid_configuration' ? 400 :
  result.error === 'configuration_conflict' || result.error === 'busy' ? 409 : 503;
export const managementError = (error: ModelManagementFailure, credentialCleanup?: ModelCleanup): ModelManagementReply => ({ version: 1, ok: false, error, ...(credentialCleanup === undefined ? {} : { credentialCleanup }) });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function validModelInput(method: ModelAction, value: unknown): boolean {
  if (method === 'list') return value === undefined;
  if (!record(value) || !revision(value.expectedRevision)) return false;
  if (method === 'default') return only(value, ['expectedRevision', 'connectionID', 'entryID']) &&
    (value.connectionID === null ? !Object.hasOwn(value, 'entryID') : id(value.connectionID) && id(value.entryID));
  if (method === 'remove') return only(value, ['expectedRevision', 'connectionID', 'replacementDefault']) && id(value.connectionID) &&
    (value.replacementDefault === undefined || value.replacementDefault === null || id(value.replacementDefault));
  if (method !== 'save' || !only(value, ['expectedRevision', 'connection', 'credential'])) return false;
  const { connection, credential } = value;
  if (!record(connection) || Object.hasOwn(connection, 'credentialRef') || Object.hasOwn(connection, 'revision') || !record(credential)) return false;
  if (credential.kind === 'replace' ? !only(credential, ['kind', 'key']) || !validModelAPIKey(credential.key) || connection.authMode !== 'apiKey' :
    (credential.kind !== 'keep' && credential.kind !== 'remove') || !only(credential, ['kind'])) return false;
  try { validateConfiguration({ schemaVersion: 2, revision: 0, defaultConnectionID: null, connections: [{ ...connection, revision: 0 }] }); return true; }
  catch { return false; }
}

export function isManagementReply(method: ModelAction, value: unknown): value is ModelManagementReply {
  if (!record(value) || value.version !== MODEL_MANAGEMENT_VERSION) return false;
  if (value.ok === false) return only(value, ['version', 'ok', 'error', 'credentialCleanup']) && MODEL_MANAGEMENT_ERRORS.some(code => code === value.error) &&
    (value.credentialCleanup === undefined || method === 'save' && ['not_needed', 'removed', 'pending', 'retained_uncertain'].some(state => state === value.credentialCleanup));
  if (value.ok !== true || !only(value, ['version', 'ok', 'configuration', 'durability', 'retainedCredentialVersions', 'writesBlocked'])) return false;
  if (method === 'list' ? value.durability !== undefined || value.retainedCredentialVersions !== undefined ||
    (value.writesBlocked !== undefined && value.writesBlocked !== true) : value.writesBlocked !== undefined ||
    (value.durability !== 'confirmed' && value.durability !== 'unconfirmed') || typeof value.retainedCredentialVersions !== 'boolean') return false;
  const configuration = value.configuration;
  if (!record(configuration) || !only(configuration, ['revision', 'defaultConnectionID', 'connections']) || !revision(configuration.revision) ||
      !Array.isArray(configuration.connections) || configuration.connections.length > 32) return false;
  const { revision: rootRevision, defaultConnectionID } = configuration;
  const connections = [];
  for (const connection of configuration.connections as unknown[]) {
    if (!record(connection) || Object.hasOwn(connection, 'credentialRef') || !revision(connection.revision) || connection.revision > rootRevision) return false;
    const { credentialState, ...rest } = connection;
    if (rest.authMode === 'none' ? credentialState !== 'not-required' : credentialState !== 'missing' && credentialState !== 'reference-present') return false;
    connections.push(rest);
  }
  try { validateConfiguration({ schemaVersion: 2, revision: rootRevision, defaultConnectionID, connections }); return true; }
  catch { return false; }
}
