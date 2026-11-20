// Development-only DSH wire format. The HTTP envelope is never forwarded upstream.
export const HARNESS_MODEL = 'pet-fixture';

export function parseHarnessRequest(body, workspace, text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 12 * 1024) return { ok: false };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const keys = ['model', 'messages', 'stream', 'stream_options', 'store', 'max_completion_tokens'];
  const options = body.stream_options;
  if (options !== undefined && (!options || Object.keys(options).length !== 1 || options.include_usage !== true)) return { ok: false };
  if (Object.keys(body).some(key => !keys.includes(key)) || body.model !== HARNESS_MODEL || body.stream !== true ||
      body.store !== false || body.max_completion_tokens !== 96 || !Array.isArray(body.messages)) return { ok: false };
  // Pinned SDK adds a system prompt and a reminder containing only the private
  // fixture cwd. Match both exactly instead of accepting arbitrary user/system text.
  const expected = [
    ['system', 'You are a helpful software engineer assistant.'],
    ['user', text],
    ['user', `<system-reminder>\nThe following information describes your current session:\n\nCurrent working directory: "${workspace}".\n</system-reminder>`],
  ];
  const ok = body.messages.length === expected.length && expected.every(([role, content], index) => {
    const row = body.messages[index];
    return !!row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === 2 && row.role === role && row.content === content;
  });
  return ok ? { ok, text: body.messages[1].content } : { ok };
}
