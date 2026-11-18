import { isProbeReply, modelProbeBytes, modelProbePath, modelProbeStatus, probeError, validProbeInput, type ModelProbeInput, type ModelProbeReply } from '../../../packages/contracts/src/model-probe.ts';
import { readBoundedJSON } from './bounded-json.ts';
import { DISCOVERY_RESPONSE_LIMIT, MODEL_DISCOVERY_PATH, discoveryError, discoveryStatus, isDiscoveryReply } from '../../app-service/src/models/discovery-contract.ts';
import { validDiscoveryInput, type ModelDiscoveryInput, type ModelDiscoveryReply } from '../../../packages/contracts/src/models.ts';
import { isManagementReply, managementError, modelStatus, MODEL_BODY_LIMIT, MODEL_MANAGEMENT_PATHS, MODEL_RESPONSE_LIMIT, validModelInput, type ModelAction, type ModelBridgeResult, type ModelInputs } from '../../app-service/src/models/management-contract.ts';

export const interruptedModelRequest = (method: ModelAction): ModelBridgeResult => method === 'list' ? managementError('unavailable') :
  { version: 1, ok: false, error: 'write_outcome_unknown' };

/** Only ServiceProcess can supply the private authenticated connection. No renderer entry. */
export async function requestModelManagement<M extends ModelAction>(
  { port, token }: { port: number; token: string }, method: M, input: ModelInputs[M], transport: typeof fetch = fetch,
): Promise<ModelBridgeResult> {
  let body: string | undefined;
  try {
    if (!Object.hasOwn(MODEL_MANAGEMENT_PATHS, method) || !validModelInput(method, input)) return managementError('invalid_configuration');
    if (method !== 'list') {
      body = JSON.stringify(input);
      if (Buffer.byteLength(body) > MODEL_BODY_LIMIT) return managementError('invalid_configuration');
    }
  } catch { return managementError('invalid_configuration'); }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) return managementError('unavailable');
  try {
    const response = await transport(`http://127.0.0.1:${port}${MODEL_MANAGEMENT_PATHS[method]}`, {
      method: method === 'list' ? 'GET' : 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const value = await readBoundedJSON(response, MODEL_RESPONSE_LIMIT);
    if (!isManagementReply(method, value) || response.status !== modelStatus(value)) throw Error();
    return value;
  } catch { return interruptedModelRequest(method); }
}

/** Read-only: disconnects never imply an unknown configuration write. */
export async function requestModelDiscovery(
  { port, token }: { port: number; token: string }, input: ModelDiscoveryInput, signal: AbortSignal, transport: typeof fetch = fetch,
): Promise<ModelDiscoveryReply> {
  if (!validDiscoveryInput(input)) return discoveryError('invalid_configuration');
  if (signal.aborted) return discoveryError('cancelled');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) return discoveryError('unavailable');
  const { connectionID, expectedRevision } = input, timeout = AbortSignal.timeout(17_000);
  try {
    const response = await transport(`http://127.0.0.1:${port}${MODEL_DISCOVERY_PATH}`, {
      method: 'POST', body: JSON.stringify({ connectionID, expectedRevision }), redirect: 'error', signal: AbortSignal.any([signal, timeout]),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const value = await readBoundedJSON(response, DISCOVERY_RESPONSE_LIMIT);
    if (signal.aborted || timeout.aborted || !isDiscoveryReply(value) || response.status !== discoveryStatus(value) ||
      (value.ok && (value.connectionID !== connectionID || value.revision !== expectedRevision))) throw Error();
    return value;
  } catch { return discoveryError(signal.aborted ? 'cancelled' : timeout.aborted ? 'timed_out' : 'unavailable'); }
}

export async function requestModelProbe(
  { port, token }: { port: number; token: string }, input: ModelProbeInput, signal: AbortSignal, transport: typeof fetch = fetch,
): Promise<ModelProbeReply> {
  if (!validProbeInput(input)) return probeError('invalid_configuration');
  if (signal.aborted) return probeError('cancelled');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) return probeError('unavailable');
  const snapshot = structuredClone(input), timeout = AbortSignal.timeout(17_000);
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body) > modelProbeBytes) return probeError('invalid_configuration');
  try {
    const response = await transport(`http://127.0.0.1:${port}${modelProbePath}`, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.any([signal, timeout]),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const value = await readBoundedJSON(response, modelProbeBytes);
    if (signal.aborted || timeout.aborted || !isProbeReply(value, snapshot) || response.status !== (value.ok ? 200 : modelProbeStatus[value.error])) throw Error();
    return value;
  } catch { return probeError(signal.aborted ? 'cancelled' : timeout.aborted ? 'timed_out' : 'unavailable'); }
}
