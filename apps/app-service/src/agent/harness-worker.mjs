// Trusted service grants one text and one loopback capability over a private IPC lifetime.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, join } from 'node:path';

// The SDK run() method routes slash commands even when given text blocks.
// The pinned prompt() API queues verbatim input and returns its inbox receipt.
async function literalTurn(harness, input) {
  await harness.start();
  const { id } = harness.session();
  const client = harness.client;
  const stream = client.subscribeSessionTree(id);
  try {
    const receipt = await client.prompt(id, [{ type: 'text', text: input }]);
    const order = ['turn/start', 'request/header', 'assistant/message', 'turn/end'];
    let step = 0, seq, text;
    for (let n = 0; n < 128; n++) {
      const { method, params } = await stream.next();
      if (method.startsWith('subagent.') || params.sessionId !== id) throw new Error('unexpected_session');
      if (method === 'session.status' && seq !== undefined && params.status === 'idle') {
        if (step !== order.length || !text?.trim() || Buffer.byteLength(text) > 24 * 1024) throw new Error('invalid_terminal');
        return text;
      }
      if (method !== 'session.event') continue;
      const event = params.event;
      if (seq === undefined) {
        if (event?.type === 'agent/inbox/spliced' && event.data?.inserted?.some(message => message.id === receipt) && Number.isSafeInteger(event.seq)) seq = event.seq;
        continue;
      }
      if (event?.seq !== ++seq || /^(tool|subagent|command)\//.test(event.type) || step === order.length) throw new Error('unexpected_activity');
      if (!order.includes(event.type)) continue;
      if (event.type !== order[step++]) throw new Error('invalid_event_order');
      if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content;
        if (!Array.isArray(blocks) || !blocks.every(block => block.type === 'text' && typeof block.text === 'string')) throw new Error('invalid_blocks');
        text = blocks.map(block => block.text).join('');
      }
      if (event.type === 'turn/end' && event.data?.reason?.kind !== 'completed') throw new Error('incomplete_turn');
    }
    throw new Error('activity_limit');
  } finally { stream.close(); }
}

async function main() {
  if (!process.connected) throw new Error('owner_missing');
  const port = Number(process.argv[2]);
  const root = process.cwd();
  const token = process.env.PET_HARNESS_TURN_TOKEN;
  if (process.platform !== 'darwin' || process.versions.electron || !process.versions.node.startsWith('24.') ||
      !Number.isInteger(port) || port <= 1024 || port > 65535 ||
      !/^pet-harness-[a-zA-Z0-9]{6}$/.test(basename(root)) || process.env.HOME !== root || process.env.TMPDIR !== root || !/^[a-f0-9]{48}$/.test(token ?? '')) throw new Error('invalid_launch');
  let harness, ownerLost = false;
  const lost = once(process, 'disconnect').then(() => { ownerLost = true; throw new Error('owner_lost'); });
  try {
    const work = (async () => {
      const [frame] = await once(process, 'message');
      if (!frame || Object.keys(frame).length !== 1 || typeof frame.text !== 'string' || !frame.text.trim() || Buffer.byteLength(frame.text) > 12 * 1024) throw new Error('invalid_turn');
      const workspace = join(root, 'workspace'), dshHome = join(root, 'dsh'), patch = join(root, 'text-only.yml');
      await mkdir(workspace); await mkdir(dshHome);
      const provider = 'pet-loopback', model = 'pet-harness';
      const disabled = ['llm-deepseek', 'session-log-deepseek', 'sessions', 'tool-fs', 'tool-working-directory', 'terminal-bash', 'terminal-pwsh', 'persistent-bash', 'persistent-pwsh', 'mcp-resources'];
      await writeFile(patch, `- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          ${provider}:
            api: openai-completions
            baseURL: http://127.0.0.1:${port}/v1
            apiKeyEnv: PET_HARNESS_TURN_TOKEN
            retryPolicy: { mode: normal, maxRetries: 0 }
            models:
              - { id: ${model}, name: Pet loopback, contextWindow: 8192, maxTokens: 96 }
${disabled.map(id => `- id: ${id}\n  disabled: true`).join('\n')}
- id: agent-loop
  config:
    agents: []
`, { mode: 0o600 });
      const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
      if (!process.connected) throw new Error('owner_lost');
      const env = { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, PET_HARNESS_TURN_TOKEN: token };
      harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome, cwd: workspace, processCwd: workspace,
        patches: [patch], provider, model, env, maxTokens: 96, initializeTimeoutMs: 7000, requestTimeoutMs: 64_000,
        shutdownTimeoutMs: 500, disposeEofGraceMs: 500, disposeGraceMs: 800 });
      return literalTurn(harness, frame.text);
    })();
    let text;
    try { text = await Promise.race([work, lost]); }
    finally {
      await harness?.close();
      // The service cannot remove this directory if it died. Only remove our
      // exact private turn root after the owned SDK process was reaped.
      if (ownerLost) await rm(root, { recursive: true, force: true });
    }
    if (!process.connected) throw new Error('owner_lost');
    await new Promise((resolve, reject) => process.send({ text }, error => error ? reject(error) : resolve()));
  } finally {
    process.removeAllListeners('message');
    if (process.connected) process.disconnect();
  }
}
try { await main(); }
catch { process.exitCode = 1; }
