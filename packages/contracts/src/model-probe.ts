import { validDiscoveryInput, type Compatibility } from './models.ts';
import { shape } from './pets.ts';

export const modelProbePath = '/v1/models/test';
export const modelProbeIPC = { testConnection: 'pet:models-test-connection', cancelConnectionTest: 'pet:models-cancel-connection-test' } as const;
export const modelProbeBytes = 2048;
export const streamingModelProbeTimeoutMs = 60_000;
export type ModelProbeInput = { connectionID: string; expectedRevision: number; entryID: string; modelID: string; maxOutputTokens?: number } & Compatibility;
export type ModelProbeOperation = ModelProbeInput & { operationID: string };
export const modelProbeStatus = {
  invalid_configuration: 400, configuration_conflict: 409, credentials_unavailable: 503, storage_unavailable: 503, publication_uncertain: 503,
  busy: 409, authentication_failed: 502, rate_limited: 429, invalid_response: 502, response_too_large: 502, upstream_unavailable: 502,
  provider_bad_request: 502, provider_forbidden: 502, provider_not_found: 502, output_budget_exhausted: 502,
  timed_out: 504, cancelled: 409, unavailable: 503,
} as const;
export type ModelProbeError = keyof typeof modelProbeStatus;
export type ModelProbeReply = { version: 1; ok: true; connectionID: string; revision: number; entryID: string } | { version: 1; ok: false; error: ModelProbeError };
export const probeError = (error: ModelProbeError): ModelProbeReply => ({ version: 1, ok: false, error });
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export function validProbeInput(value: unknown): value is ModelProbeInput {
  return shape(value, ['connectionID', 'expectedRevision', 'entryID', 'modelID', 'maxOutputTokens', 'outputTokenField']) &&
    validDiscoveryInput({ connectionID: value.connectionID, expectedRevision: value.expectedRevision }) && identifier(value.entryID) &&
    typeof value.modelID === 'string' && value.modelID.length > 0 && value.modelID.length <= 256 && new TextEncoder().encode(value.modelID).byteLength <= 256 &&
    !/[\s\x00-\x1f\x7f-\x9f\p{Cs}]/u.test(value.modelID) &&
    (value.maxOutputTokens === undefined || typeof value.maxOutputTokens === 'number' && Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens >= 1 && value.maxOutputTokens <= 2147483647) &&
    (value.outputTokenField === undefined || value.outputTokenField === 'max_tokens' || value.outputTokenField === 'max_completion_tokens');
}
export function isProbeReply(value: unknown, input: ModelProbeInput): value is ModelProbeReply {
  return shape(value, ['version', 'ok', 'error']) && value.version === 1 && value.ok === false && typeof value.error === 'string' && Object.hasOwn(modelProbeStatus, value.error) ||
    shape(value, ['version', 'ok', 'connectionID', 'revision', 'entryID']) && value.version === 1 && value.ok === true && value.connectionID === input.connectionID && value.revision === input.expectedRevision && value.entryID === input.entryID;
}
