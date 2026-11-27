import { characterLearningPaths, isCharacterLearningChatSelection, characterLearningReplyBytes, isCharacterLearningInput, isCharacterLearningGenerateInput, isCharacterLearningPreviewResult, isCharacterLearningGenerateResult, isCharacterLearningCancelResult, type CharacterLearningBridge } from '../../../packages/contracts/src/character-learning.ts';
export type LearningMethod = keyof CharacterLearningBridge;
export type LearningInput<M extends LearningMethod> = Parameters<CharacterLearningBridge[M]>[0];
export type LearningResult<M extends LearningMethod> = Awaited<ReturnType<CharacterLearningBridge[M]>> | {ok:false;error:'unavailable'};
const unavailable = {ok:false,error:'unavailable'} as const;
export async function requestCharacterLearning<M extends LearningMethod>(connection:{port:number;token:string},method:M,input:LearningInput<M>,fetcher:typeof fetch=fetch,signal?:AbortSignal):Promise<LearningResult<M>> {
  if (!Object.hasOwn(characterLearningPaths,method) || !(method === 'generate' ? isCharacterLearningGenerateInput(input) : method==='selectChatTurn' ? isCharacterLearningChatSelection(input) : isCharacterLearningInput(input))) return unavailable;
  try {
    const timeout=AbortSignal.timeout(method==='generate'?45000:6500);
    const response=await fetcher(`http://127.0.0.1:${connection.port}${characterLearningPaths[method]}`,{
      method:'POST',body:JSON.stringify(input),redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
      headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},
    });
    if(!response.headers.get('content-type')?.startsWith('application/json') || !response.body || Number(response.headers.get('content-length'))>characterLearningReplyBytes) return unavailable;
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>characterLearningReplyBytes){await reader.cancel();return unavailable;}chunks.push(value);}}finally{reader.releaseLock();}
    const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    const valid = method==='preview'||method==='selectChatTurn'?isCharacterLearningPreviewResult(result):method==='generate'?isCharacterLearningGenerateResult(result):isCharacterLearningCancelResult(result);
    if(!valid || !(result && typeof result==='object' && 'ok' in result) || result.ok!==response.ok) return unavailable;
    if(isCharacterLearningPreviewResult(result) && result.ok && (result.preview.petID!==input.petID || ('ticket' in input ? result.preview.ticket!==input.ticket : result.preview.source!=='chat')))return unavailable;
    if(isCharacterLearningGenerateResult(result) && result.ok && result.petID!==input.petID)return unavailable;
    return result as LearningResult<M>;
  } catch {return unavailable;}
}

/** Owns the original generate connection as well as the independent revocation request. */
export class CharacterLearningRequests {
  private readonly running = new Map<string, { petID: string; abort: AbortController }>();
  constructor(private readonly revoke: (input: LearningInput<'cancel'>) => Promise<LearningResult<'cancel'>>) {}
  async generate(input: LearningInput<'generate'>, send: (signal: AbortSignal) => Promise<LearningResult<'generate'>>): Promise<LearningResult<'generate'>> {
    if (this.running.has(input.ticket)) return { ok: false, error: 'busy' };
    const abort = new AbortController();
    this.running.set(input.ticket, { petID: input.petID, abort });
    try {
      const result = await send(abort.signal);
      return abort.signal.aborted ? { ok: false, error: 'write-outcome-unknown' } : result;
    } finally { this.running.delete(input.ticket); }
  }
  async cancel(input: LearningInput<'cancel'>): Promise<LearningResult<'cancel'>> {
    const active = this.running.get(input.ticket);
    if (active && active.petID !== input.petID) return unavailable;
    active?.abort.abort();
    const result = await this.revoke(input).catch(() => unavailable);
    return active && !result.ok ? { ok: false, error: 'write-outcome-unknown' } : result;
  }
}
