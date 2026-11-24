import { randomUUID } from 'node:crypto';
import { WORKSPACE_URL } from './security.ts';

const origin = 'pet-app://workspace';
export function isMicrophonePermission(permission: string, details: {
  requestingUrl?: string; securityOrigin?: string; isMainFrame: boolean; mediaType?: string; mediaTypes?: string[];
}, phase: 'check' | 'request', requestingOrigin?: string): boolean {
  return permission === 'media' && details.isMainFrame &&
    (details.requestingUrl === WORKSPACE_URL || details.requestingUrl?.startsWith(`${WORKSPACE_URL}#`) === true) &&
    (details.securityOrigin === undefined || details.securityOrigin === origin || details.securityOrigin === `${origin}/`) &&
    (phase === 'check' ? (requestingOrigin === origin || requestingOrigin === `${origin}/`) && details.mediaType === 'audio'
      : details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
}

type Ticket = { id: string; phase: 'open' | 'recording' | 'transcribing'; deadline: number; requested?: boolean; abort: AbortController; timer?: ReturnType<typeof setTimeout> };

export class MicrophoneGate {
  private ticket?: Ticket;
  private opening?: symbol;
  constructor(private readonly onRevoke: (id: string) => void, private readonly clock = Date.now) {}
  get busy() { return !!this.opening || !!this.current(); }
  canOpen() { return this.current()?.phase === 'open'; }
  takeRequest(): boolean {
    const ticket = this.current();
    if (!ticket || ticket.phase !== 'open' || ticket.requested) return false;
    ticket.requested = true;
    return true;
  }
  async armAfter(stopSpeech: () => Promise<boolean>, eligible: () => boolean): Promise<string | undefined> {
    if (this.busy || !eligible()) return;
    const opening = this.opening = Symbol();
    try {
      if (!await stopSpeech() || this.opening !== opening || !eligible()) return;
      this.opening = undefined;
      return this.arm();
    } finally { if (this.opening === opening) this.opening = undefined; }
  }
  arm(): string | undefined {
    if (this.busy) return;
    const ticket: Ticket = { id: randomUUID(), phase: 'open', deadline: 0, abort: new AbortController() };
    this.ticket = ticket;
    this.schedule(ticket, 8_000);
    return ticket.id;
  }
  started(id: unknown): boolean {
    const ticket = this.current();
    if (!ticket || ticket.id !== id || ticket.phase !== 'open' || !ticket.requested) return false;
    ticket.phase = 'recording';
    this.schedule(ticket, 32_000);
    return true;
  }
  finish(id: unknown): AbortSignal | undefined {
    const ticket = this.current();
    if (!ticket || ticket.id !== id || ticket.phase !== 'recording') return;
    ticket.phase = 'transcribing';
    clearTimeout(ticket.timer);
    return ticket.abort.signal;
  }
  release(id: unknown) {
    if (this.ticket?.id !== id) return;
    clearTimeout(this.ticket?.timer);
    this.ticket = undefined;
  }
  revoke(id: unknown = this.ticket?.id) {
    // Lifecycle revocation can arrive before a pending gesture owns any ticket.
    if (id === undefined) this.opening = undefined;
    const ticket = this.ticket;
    if (!ticket || ticket.id !== id) return;
    this.release(id);
    ticket.abort.abort();
    this.onRevoke(ticket.id);
  }
  private current() {
    const ticket = this.ticket;
    if (ticket && ticket.phase !== 'transcribing' && ticket.deadline <= this.clock()) this.revoke(ticket.id);
    return this.ticket;
  }
  private schedule(ticket: Ticket, delay: number) {
    clearTimeout(ticket.timer);
    ticket.deadline = this.clock() + delay;
    ticket.timer = setTimeout(() => this.revoke(ticket.id), delay);
    ticket.timer.unref();
  }
}
