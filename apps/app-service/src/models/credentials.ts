import { randomBytes } from 'node:crypto';
import { ModelError } from './errors.ts';

/** Trusted host port to an OS secure store. create MUST be add-only (never upsert),
 * use the supplied exact service/account, and must not log its secret or errors.
 * No default backend and no plaintext/file/CLI fallback. Not a renderer contract. */
export interface SecureCredentialBackend {
  create(service: string, account: string, secret: string): Promise<string | void>;
  read(service: string, account: string): Promise<string | undefined>;
  remove(service: string, account: string, receipt?: string): Promise<void>;
}
/** The backend may have created the item but did not confirm ownership. */
export class CredentialPreparationUncertain extends ModelError {
  constructor() { super('credentials_unavailable'); }
}
export type PreparedCredential = Readonly<{ ref: string }>;
export const CREDENTIAL_SERVICE = 'local.anime-desktop-pets.models.v2';
export const isVaultReference = (ref: unknown): ref is string => typeof ref === 'string' && /^mcred-v1-[a-f0-9]{64}$/.test(ref);
const validKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0 && key.length <= 8192 && /^[\x21-\x7e]+$/.test(key);
const MAX_PENDING_READS = 3;
const cancelled = (signal: AbortSignal) => { if (signal.aborted) throw new ModelError('cancelled'); };

export class CredentialVault {
  private pendingReads = 0;
  private readonly preparations = new WeakMap<PreparedCredential, { phase: 'pending' | 'published' | 'discarding'; receipt?: string }>();
  constructor(private readonly backend?: SecureCredentialBackend) {}
  async prepare(connectionID: string, key: string): Promise<PreparedCredential> {
    if (!this.backend || typeof connectionID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connectionID) || !validKey(key)) throw new ModelError('credentials_unavailable');
    const ref = `mcred-v1-${randomBytes(32).toString('hex')}`;
    // Bind the stored envelope to its immutable version, so copying another
    // account's payload cannot silently change the identity of this reference.
    const payload = JSON.stringify({ version: 1, ref, connectionID, key });
    let receipt: string | void;
    try { receipt = await this.backend.create(CREDENTIAL_SERVICE, ref, payload); }
    catch (e) { throw e instanceof CredentialPreparationUncertain ? new CredentialPreparationUncertain() : new ModelError('credentials_unavailable'); }
    const item = Object.freeze({ ref }); this.preparations.set(item, { phase: 'pending', receipt: receipt ?? undefined }); return item;
  }
  async read(ref: string, signal: AbortSignal, connectionID?: string): Promise<string | undefined> {
    cancelled(signal);
    if (!this.backend || !isVaultReference(ref)) throw new ModelError('credentials_unavailable');
    // The caller can stop waiting before the OS helper closes. Keep that read
    // counted until the backend has actually settled, even after cancellation.
    if (this.pendingReads >= MAX_PENDING_READS) throw new ModelError('busy');
    this.pendingReads++;
    let raw: string | undefined;
    try { raw = await this.backend.read(CREDENTIAL_SERVICE, ref); }
    catch { cancelled(signal); throw new ModelError('credentials_unavailable'); }
    finally { this.pendingReads--; }
    cancelled(signal);
    if (raw === undefined) return undefined;
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16_384) throw Error();
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      const v = value as Record<string, unknown>;
      if (Object.keys(v).sort().join(',') !== 'connectionID,key,ref,version' || v.version !== 1 || v.ref !== ref || typeof v.connectionID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v.connectionID) || !validKey(v.key)) throw Error();
      if (connectionID !== undefined && v.connectionID !== connectionID) throw Error();
      return v.key;
    } catch { throw new ModelError('credentials_unavailable'); }
  }
  publish(item: PreparedCredential): void {
    if (this.preparations.get(item)?.phase !== 'pending') throw new ModelError('credentials_unavailable');
    this.preparations.set(item, { phase: 'published' });
  }
  /** Only the exact handle prepared here can delete a still-unpublished item.
   * Failed cleanup stays retryable; old/published versions are never GC'd here. */
  async discard(item: PreparedCredential): Promise<boolean> {
    const preparation = this.preparations.get(item);
    if (!this.backend || preparation?.phase !== 'pending') return false;
    preparation.phase = 'discarding';
    try { await this.backend.remove(CREDENTIAL_SERVICE, item.ref, preparation.receipt); this.preparations.delete(item); return true; }
    catch { preparation.phase = 'pending'; return false; }
  }
}
