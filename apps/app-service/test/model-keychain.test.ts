import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';
import { MacKeychainBackend, type KeychainSpawn } from '../src/models/mac-keychain.ts';

const helper = resolve('synthetic-trusted','model-keychain');
const service = 'local.anime-desktop-pets.models.v2';
const account = `mcred-v1-${'b'.repeat(64)}`;
const receipt = Buffer.from('SYNTHETIC-ITEM-REFERENCE').toString('base64');
const secret = 'SYNTHETIC-KEY-PIPE-ONLY';
const unavailable = { name: 'ModelError', message: 'credentials_unavailable' };
function fixture(program: string, timeoutMs = 2000) {
  const calls: Parameters<KeychainSpawn>[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const backend = new MacKeychainBackend(helper, { timeoutMs, spawn: (...args) => {
    calls.push(args);
    const child = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); return child;
  } });
  return { backend, calls, children };
}
test('credential material travels by stdin only; helper path, argv and environment are fixed', async () => {
  const { backend, calls } = fixture(`let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ const a=JSON.parse(s); if(a.version!==1 || a.operation!=='create' || a.account!==${JSON.stringify(account)} || a.secret!==${JSON.stringify(secret)}) process.exit(2); process.stdout.write(JSON.stringify({version:1,status:'ok',receipt:${JSON.stringify(receipt)}})); });`);
  assert.equal(await backend.create(service, account, secret),receipt);
  assert.equal(calls[0]![0], helper); assert.deepEqual(calls[0]![1], []);
  assert.deepEqual(calls[0]![2], { stdio: ['pipe', 'pipe', 'ignore'], env: { LC_ALL: 'C' } });
  assert.doesNotMatch(JSON.stringify(calls), /SYNTHETIC|models\.v2|mcred-v1/);
});
test('invalid namespace, account and payload never spawn a helper', async () => {
  const { backend, calls } = fixture('process.exit(42)');
  await assert.rejects(backend.create('old-store', account, secret), unavailable);
  await assert.rejects(backend.read(service, '../../other'), unavailable);
  await assert.rejects(backend.create(service, account, secret.repeat(1000)), unavailable);
  assert.equal(calls.length, 0);
});
test('temporary backend returns a bounded exact envelope and handles missing records', async () => {
  const { backend } = fixture(`let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ const a=JSON.parse(s); if('secret' in a || a.account!==${JSON.stringify(account)}) process.exit(2); process.stdout.write(JSON.stringify(a.operation==='read' ? {version:1,status:'ok',secret:${JSON.stringify(secret)}} : a.receipt===${JSON.stringify(receipt)} ? {version:1,status:'ok'} : {version:1,status:'unavailable'})); });`);
  assert.equal(await backend.read(service, account), secret); await backend.remove(service, account, receipt);
  const missing = fixture(`process.stdout.write('{"version":1,"status":"missing"}');`).backend;
  assert.equal(await missing.read(service, account), undefined); await assert.rejects(missing.remove(service, account, receipt), unavailable);
});
for (const [name, program] of Object.entries({ unavailable: `process.stdout.write('{"version":1,"status":"unavailable"}')`, malformed: `process.stdout.write('{"version":1,"status":"ok","secret":"SYNTHETIC","extra":true}')`, noisy: `process.stdout.write('x'.repeat(130000))`, nonzero: `process.stdout.write('{"version":1,"status":"ok","secret":"SYNTHETIC"}'); process.exitCode=1`, hung: `setInterval(()=>{},100)` })) {
  test(`${name} helper result is sanitized and child has been reaped`, async () => {
    const { backend, children } = fixture(program, name === 'hung' ? 150 : 2000);
    await assert.rejects(backend.read(service, account), unavailable);
    assert.ok(children[0]!.exitCode !== null || children[0]!.signalCode !== null);
  });
}

test('create rejection is distinct from lost acknowledgement; indeterminate writes are not deleted', async () => {
  const definite = fixture(`process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('{"version":1,"status":"unavailable"}'));`);
  const lost = fixture(`process.stdin.resume(); process.stdin.on('end',()=>process.exit(1));`);
  await assert.rejects(definite.backend.create(service, account, secret), e => e instanceof Error && e.constructor.name === 'ModelError');
  await assert.rejects(lost.backend.create(service, account, secret), e => e instanceof Error && e.constructor.name === 'CredentialPreparationUncertain');
  assert.equal(lost.calls.length,1);
});

test('rollback carries only the receipt of its own prepared item and cannot claim cleanup from a different Keychain', async () => {
  const { CredentialVault } = await import('../src/models/credentials.ts');
  const { backend, calls } = fixture(`let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ const a=JSON.parse(s); if(a.operation==='create') process.stdout.write(JSON.stringify({version:1,status:'ok',receipt:${JSON.stringify(receipt)}})); else if(a.operation==='remove' && a.receipt===${JSON.stringify(receipt)}) process.stdout.write('{"version":1,"status":"missing"}'); else process.exit(9); });`);
  await assert.rejects(backend.remove(service, account, 'invalid receipt'), unavailable);
  assert.equal(calls.length,0);
  const vault = new CredentialVault(backend);
  const pending = await vault.prepare('test-connection',secret);
  assert.deepEqual(Object.keys(pending),['ref']);
  assert.equal(await vault.discard(pending),false);
  assert.equal(calls.length,2);
});
