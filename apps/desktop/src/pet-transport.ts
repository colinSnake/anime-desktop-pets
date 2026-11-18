import { isPetInput, isPetResult, type PetResult } from '../../../packages/contracts/src/pets.ts';
import type { PetMethod } from './pet-ipc.ts';
export async function requestPets(connection: { base: string; token: string }, method: PetMethod, input?: unknown): Promise<PetResult> {
  if (method !== 'list' && !isPetInput(method, input)) return {ok:false,error:'invalid'};
  if (method === 'list' && input !== undefined) return {ok:false,error:'invalid'};
  try {
    const path = method === 'applyDisplay' ? 'apply-display' : method === 'applyBehavior' ? 'apply-behavior' : method;
    const response = await fetch(`${connection.base}/v1/pets${method === 'list' ? '' : `/${path}`}`, {
      method: method === 'list' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${connection.token}`, ...(method === 'list' ? {} : {'content-type':'application/json'}) },
      ...(method === 'list' ? {} : { body: JSON.stringify(input) }),
    });
    const value: unknown = await response.json();
    if (!isPetResult(value) || (value.ok && !response.ok)) return {ok:false,error:'unavailable'};
    return value;
  } catch { return {ok:false,error:'unavailable'}; }
}
