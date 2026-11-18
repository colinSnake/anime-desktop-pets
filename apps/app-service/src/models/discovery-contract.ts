import { MODEL_DISCOVERY_ERRORS, validDiscoveryCandidate, validDiscoveryInput, type ModelDiscoveryError, type ModelDiscoveryReply } from '../../../../packages/contracts/src/models.ts';

export const MODEL_DISCOVERY_PATH = '/v1/models/discover';
export const DISCOVERY_BODY_LIMIT = 512;
export const DISCOVERY_RESPONSE_LIMIT = 256 * 1024;
export const discoveryError = (error: ModelDiscoveryError): ModelDiscoveryReply => ({ version: 1, ok: false, error });
export const discoveryStatus = (result: ModelDiscoveryReply) => {
  if (result.ok) return 200;
  switch (result.error) {
    case 'invalid_configuration': return 400;
    case 'configuration_conflict': case 'busy': case 'cancelled': return 409;
    case 'timed_out': return 504;
    case 'authentication_failed': case 'invalid_response': case 'response_too_large': case 'upstream_unavailable': return 502;
    default: return 503;
  }
};
export function isDiscoveryReply(value: unknown): value is ModelDiscoveryReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (v.ok === false) return Object.keys(v).length === 3 && MODEL_DISCOVERY_ERRORS.includes(v.error as ModelDiscoveryError);
  return v.ok === true && Object.keys(v).length === 6 && typeof v.truncated === 'boolean' &&
    validDiscoveryInput({ connectionID: v.connectionID, expectedRevision: v.revision }) &&
    Array.isArray(v.candidates) && v.candidates.length <= 256 && v.candidates.every(validDiscoveryCandidate) &&
    new Set(v.candidates.map(model => model.modelID)).size === v.candidates.length;
}
