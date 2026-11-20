import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceDevConfig, workspaceDevResponse } from '../src/workspace-ui-hmr.ts';

const token = 'a'.repeat(64), proof = 'b'.repeat(64);
const activation = `54321:${token}:${proof}`;
test('workspace HMR needs an explicit dev launch and rejects invalid activation', () => {
  assert.equal(workspaceDevConfig(false, true, activation), undefined);
  assert.equal(workspaceDevConfig(true, false, activation), undefined);
  assert.throws(() => workspaceDevConfig(true, true, `https://example.com:${token}:${proof}`));
  assert.throws(() => workspaceDevConfig(true, true, `65536:${token}:${proof}`));
});

test('HMR only serves authenticated loopback responses under the workspace origin', async () => {
  const config = workspaceDevConfig(true, true, activation)!;
  const requests: URL[] = [];
  const fetchModule: typeof fetch = async (input, init) => {
    requests.push(new URL(String(input)));
    assert.equal(new Headers(init?.headers).get('x-pet-dev-token'), token);
    assert.equal(init?.redirect, 'error');
    return new Response('working UI', { headers: { 'x-pet-dev-proof': proof, 'content-type': 'text/html' } });
  };
  const response = await workspaceDevResponse(config, new Request('pet-app://workspace/index.html'), fetchModule);
  assert.equal(await response.text(), 'working UI');
  assert.match(response.headers.get('content-security-policy')!, /connect-src ws:\/\/127\.0\.0\.1:54321/);
  assert.equal(response.headers.get('x-pet-dev-proof'), null);
  for (const url of ['pet-app://workspace//example.com/src/main.tsx', 'pet-app://workspace/package.json',
    'pet-app://another/src/main.tsx', 'pet-app://workspace:4321/src/main.tsx']) {
    assert.equal((await workspaceDevResponse(config, new Request(url), fetchModule)).status, 404);
  }
  assert.equal((await workspaceDevResponse(config, new Request('pet-app://workspace/src/main.tsx', { method: 'POST' }), fetchModule)).status, 404);
  assert.deepEqual(requests.map(url => url.href), ['http://127.0.0.1:54321/index.html']);
  const replaced = await workspaceDevResponse(config, new Request('pet-app://workspace/index.html'),
    async () => new Response('untrusted UI', { headers: { 'content-type': 'text/html' } }));
  assert.equal(replaced.status, 503);
  assert.equal(await replaced.text(), '');
});
