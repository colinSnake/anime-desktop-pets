import { randomBytes } from 'node:crypto';

// Synthetic DTOs only. Not a general Provider proxy or runtime admission policy.
function validBody(body, binding) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = ['model', 'messages', 'stream', 'stream_options', 'store', 'max_completion_tokens'];
  const options = body.stream_options;
  const validStreamOptions = options === undefined || (options && Object.keys(options).length === 1 && options.include_usage === true);
  return validStreamOptions && Object.keys(body).every(key => keys.includes(key)) && body.model === binding.model && body.stream === true &&
    body.store === false && body.max_completion_tokens === 96 && Array.isArray(body.messages) &&
    body.messages.length <= 4 && body.messages.every(row => row && Object.keys(row).length === 2 &&
      (row.role === 'system' || row.role === 'user') && typeof row.content === 'string' && row.content.length <= 4096) &&
    body.messages.filter(row => row.role === 'user' && row.content === binding.text).length === 1;
}

export function createFixtureAdmission() {
  const seen = new Set(), active = new Set();
  return { open(binding, currentRevision) {
    const { petID, requestID, model, text, revision } = binding;
    if (active.has(petID) || seen.has(requestID)) return;
    seen.add(requestID); active.add(petID);
    const capability = randomBytes(24).toString('hex');
    let used = false, closed = false;
    const close = () => { if (!closed) { closed = true; active.delete(petID); } };
    return { capability, close, claim(header, body) {
      if (closed || header !== `Bearer ${capability}`) return 'forbidden';
      if (used) return 'used';
      if (currentRevision() !== revision) { close(); return 'stale'; }
      if (!validBody(body, { model, text })) return 'invalid';
      used = true; // Before producing any response, including in an unknown/partial outcome.
      return 'admitted';
    } };
  } };
}

export function validTextEvents(events) {
  const order = ['turn/start', 'request/header', 'assistant/message', 'turn/end'];
  if (!Array.isArray(events) || !events.length || events.length > 64) return false;
  let step = 0;
  return events.every((event, index) => {
    if (typeof event?.type !== 'string' || event.seq !== index || /^(tool|subagent)\//.test(event.type)) return false;
    if (!order.includes(event.type)) return true;
    if (event.type !== order[step]) return false;
    return ++step < order.length || index === events.length - 1;
  }) && step === order.length;
}
