import { createHash, randomUUID } from 'node:crypto';
import type { OnlineChatInput } from '../../../../packages/contracts/src/online-chat.ts';

const digest = ({ materialGrant: _grant, ...turn }: OnlineChatInput) => createHash('sha256').update(JSON.stringify(turn)).digest('hex');

/** Service-owned, ephemeral permission. Retains no attachments, prompt or credential. */
export class ChatMaterialGrants {
 private readonly grants = new Map<string, { key: string; digest: string; expires: number }>();
 issue(input: OnlineChatInput) {
  const now = performance.now();
  for (const [key, value] of this.grants) if (value.expires <= now) this.grants.delete(key);
  const fingerprint = digest(input);
  // The current desktop has only one outstanding approval per pet. Replacing it
  // invalidates any abandoned attempt instead of filling the bounded store.
  if (!this.grants.has(input.petID) && this.grants.size >= 32) return;
  const grant = randomUUID();
  this.grants.set(input.petID, { key: grant, digest: fingerprint, expires: now + 30_000 });
  return grant;
 }
 consume(input: OnlineChatInput) {
  if (!input.attachments?.length) return true;
  const key = input.materialGrant;
  if (!key) return false;
  const item = this.grants.get(input.petID);
  if (!item || item.key !== key || item.expires <= performance.now() || item.digest !== digest(input)) return false;
  this.grants.delete(input.petID);
  return true;
 }
}
