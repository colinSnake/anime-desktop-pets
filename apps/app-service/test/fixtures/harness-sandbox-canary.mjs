// Synthetic Worker used to challenge the product sandbox and Provider gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

try {
  const [{ text }] = await once(process, 'message');
  const { canary, deniedPort } = JSON.parse(text);
  await assert.rejects(readFile(canary), { code: 'EPERM' });
  await assert.rejects(writeFile(canary, 'changed'), { code: 'EPERM' });
  await assert.rejects(fetch(`http://127.0.0.1:${deniedPort}/`, { signal: AbortSignal.timeout(1000) }));
  assert.equal(spawnSync('/usr/bin/true').status, null);
  const port = Number(process.argv[2]);
  const body = { model: 'pet-harness', stream: true, store: false, max_completion_tokens: 96, messages: [
    { role: 'system', content: 'You are a helpful software engineer assistant.' },
    { role: 'user', content: text },
    { role: 'user', content: `<system-reminder>\nThe following information describes your current session:\n\nCurrent working directory: "${join(process.cwd(), 'workspace')}".\n</system-reminder>` },
  ] };
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const send = (value, token = process.env.PET_HARNESS_TURN_TOKEN) => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  const wrongToken = await send(body, 'invalid');
  assert.equal(wrongToken.status, 403); await wrongToken.text();
  const tools = await send({ ...body, tools: [] });
  assert.equal(tools.status, 422); await tools.text();
  const dispatched = await send(body);
  assert.equal(dispatched.status, 200); assert.match(await dispatched.text(), /合成门禁通过/);
  const replay = await send(body);
  assert.equal(replay.status, 409); await replay.text();
  await new Promise((resolve, reject) => process.send({ text: '合成门禁通过' }, error => error ? reject(error) : resolve()));
} catch { process.exitCode = 1; }
finally { if (process.connected) process.disconnect(); }
