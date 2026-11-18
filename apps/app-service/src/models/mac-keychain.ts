import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CREDENTIAL_SERVICE, CredentialPreparationUncertain, isVaultReference, type SecureCredentialBackend } from './credentials.ts';
import { ModelError } from './errors.ts';

export type KeychainSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type Operation = 'create' | 'read' | 'remove';
const WIRE_LIMIT = 64 * 1024;
const PAYLOAD_LIMIT = 16 * 1024;
const unavailable = () => new ModelError('credentials_unavailable');
const validReceipt = (receipt: unknown): receipt is string => typeof receipt === 'string' && receipt.length > 0 && receipt.length <= 4096 && Buffer.from(receipt, 'base64').toString('base64') === receipt;
const validPayload = (secret: unknown): secret is string => typeof secret === 'string' && secret.length > 0 && Buffer.byteLength(secret) <= PAYLOAD_LIMIT;

/** Trusted utility-process adapter. The only executable selection is supplied
 * by the service entrypoint from its packaged directory, never from the wire. */
export class MacKeychainBackend implements SecureCredentialBackend {
  constructor(private readonly executable: string, private readonly options: { spawn?: KeychainSpawn; timeoutMs?: number } = {}) {}
  create(service: string, account: string, secret: string): Promise<string | undefined> {
    return this.execute('create', service, account, { secret });
  }
  read(service: string, account: string): Promise<string | undefined> {
    return this.execute('read', service, account);
  }
  async remove(service: string, account: string, receipt?: string): Promise<void> {
    await this.execute('remove', service, account, { receipt });
  }
  private async execute(operation: Operation, service: string, account: string, material: { secret?: string; receipt?: string } = {}): Promise<string | undefined> {
    if ((!this.options.spawn && process.platform !== 'darwin') || !isAbsolute(this.executable) ||
        service !== CREDENTIAL_SERVICE || !isVaultReference(account) || operation === 'create' && !validPayload(material.secret) ||
        operation === 'remove' && !validReceipt(material.receipt)) throw unavailable();
    const input = Buffer.from(JSON.stringify({ version: 1, operation, account, ...material }));
    if (input.byteLength > WIRE_LIMIT) { input.fill(0); throw unavailable(); }
    const badReply = () => operation === 'create' ? new CredentialPreparationUncertain() : unavailable();
    let stdout: Buffer;
    try { stdout = await this.run(input); }
    catch { throw badReply(); }
    finally { input.fill(0); }
    let value: Record<string, unknown>;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)) as Record<string, unknown>; }
    catch { throw badReply(); }
    finally { stdout.fill(0); }
    if (!value || value.version !== 1) throw badReply();
    const keys = Object.keys(value).sort().join(',');
    if (value.status === 'unavailable' && keys === 'status,version') throw unavailable();
    if (value.status === 'missing' && operation === 'read' && keys === 'status,version') return undefined;
    if (value.status !== 'ok') throw badReply();
    if (operation === 'create' && keys === 'receipt,status,version' && validReceipt(value.receipt)) return value.receipt;
    if (operation === 'read' && keys === 'secret,status,version' && validPayload(value.secret)) return value.secret;
    if (operation === 'remove' && keys === 'status,version') return undefined;
    throw badReply();
  }
  private run(input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = (this.options.spawn ?? spawn)(this.executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { LC_ALL: 'C' } });
      const chunks: Buffer[] = [];
      let size = 0, failed = false;
      const abort = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(abort, this.options.timeoutMs ?? 2500);
      child.once('error', abort);
      child.once('close', code => {
        clearTimeout(timer);
        const result = failed || code !== 0 ? undefined : Buffer.concat(chunks, size);
        for (const chunk of chunks) chunk.fill(0);
        if (result) resolve(result); else reject(unavailable());
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (failed || size + chunk.length > WIRE_LIMIT) { chunk.fill(0); abort(); return; }
        size += chunk.length; chunks.push(chunk);
      });
      if (!child.stdin || !child.stdout) { abort(); return; }
      child.stdin.on('error', abort);
      child.stdin.end(input);
    });
  }
}
