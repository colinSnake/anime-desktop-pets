import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PetCoverProvider, COVER_URL } from '../src/pet-cover.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');

test('only the exact versioned same-origin development cover GET can invoke the decoder', async () => {
  let reads = 0;
  const provider = new PetCoverProvider({ assets: '/trusted/assets', workerPath: '/trusted/cover.py' }, async () => { reads++; return png; });
  for (const url of [COVER_URL+'?path=/private', COVER_URL+'#x', COVER_URL.replace('workspace', 'other'), COVER_URL.replace('0.0.0-dev', '1.0.0'), 'file:///private/data', 'pet-app://workspace/covers/%2e%2e/secret']) {
    assert.equal(await provider.response(url, 'GET'), undefined);
  }
  assert.equal(await provider.response(COVER_URL, 'POST'), undefined);
  assert.equal(reads, 0);
  const responses = await Promise.all(Array.from({length: 4}, () => provider.response(COVER_URL, 'GET')));
  assert.equal(reads, 1);
  for (const response of responses) {
    assert.equal(response?.status, 200); assert.equal(response?.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response!.arrayBuffer()), png);
  }
  await provider.close(); assert.equal((await provider.response(COVER_URL, 'GET'))?.status, 404);
});

test('unconfigured, invalid, failed and oversized decodes return a neutral miss without exposing paths', async () => {
  for (const options of [undefined, {assets: 'relative', workerPath: '/trusted/cover.py'}]) {
    const provider = new PetCoverProvider(options, async () => assert.fail('must not decode'));
    assert.equal((await provider.response(COVER_URL, 'GET'))?.status, 404);
    await provider.close();
  }
  for (const decode of [async () => {throw Error('/private/secret');}, async () => Buffer.from('not png'), async () => Buffer.alloc(1024*1024+1)]) {
    const provider = new PetCoverProvider({assets:'/trusted/assets',workerPath:'/trusted/cover.py'}, decode);
    const response = await provider.response(COVER_URL, 'GET');
    assert.equal(response?.status, 404); assert.equal(await response?.text(), ''); await provider.close();
  }
});

test('closing aborts the owned decode, waits for it, and never publishes its late result', async () => {
  let aborted = false;
  const provider = new PetCoverProvider({assets:'/trusted/assets',workerPath:'/trusted/cover.py'}, async (_options, signal) => new Promise<Buffer>(resolve => {
    signal.addEventListener('abort', () => {aborted = true; resolve(png);}, {once:true});
  }));
  const result = provider.response(COVER_URL, 'GET');
  await provider.close(); assert.equal(aborted, true); assert.equal((await result)?.status, 404);
});

const python = process.env.PET_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
test('real private decoder input is versioned and sanitized without requiring Qt or Pillow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-cover-process-'));
  const workerPath = join(root, 'cover.py');
  const previous = process.env.PET_COVER_TEST_SECRET;
  process.env.PET_COVER_TEST_SECRET = 'synthetic-secret';
  try {
    await writeFile(workerPath, `import sys,json,os,base64
v=json.load(sys.stdin)
assert set(v)=={'version','assets'} and v['version']==1
assert 'PET_COVER_TEST_SECRET' not in os.environ
sys.stdout.buffer.write(base64.b64decode('${png.toString('base64')}'))
`);
    const provider = new PetCoverProvider({assets:root,workerPath,python});
    try {
      const response = await provider.response(COVER_URL,'GET');
      assert.equal(response?.status,200); assert.deepEqual(Buffer.from(await response!.arrayBuffer()),png);
    } finally { await provider.close(); }
  } finally {
    if (previous === undefined) delete process.env.PET_COVER_TEST_SECRET; else process.env.PET_COVER_TEST_SECRET=previous;
    await rm(root,{recursive:true,force:true});
  }
});

test('close reaps the real owned thumbnail child before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-cover-close-'));
  const workerPath = join(root,'cover.py');
  await writeFile(workerPath, "import sys,json,os,pathlib,time\nv=json.load(sys.stdin)\npathlib.Path(v['assets'],'pid').write_text(str(os.getpid()))\ntime.sleep(30)\n");
  const provider = new PetCoverProvider({assets:root,workerPath,python});
  try {
    const response = provider.response(COVER_URL,'GET');
    let pid: number | undefined;
    const deadline=Date.now()+2000;
    while (Date.now()<deadline) {
      try { pid=Number(await readFile(join(root,'pid'),'utf8')); break; } catch {}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(pid, 'synthetic decoder must start');
    await provider.close();
    assert.throws(()=>process.kill(pid!,0));
    assert.equal((await response)?.status,404);
  } finally { await provider.close(); await rm(root,{recursive:true,force:true}); }
});

test('a hung owned decoder is bounded by the fixed timeout and reaped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-cover-timeout-'));
  const workerPath = join(root, 'cover.py');
  await writeFile(workerPath, "import sys,json,os,pathlib,time\nv=json.load(sys.stdin)\npathlib.Path(v['assets'],'pid').write_text(str(os.getpid()))\ntime.sleep(30)\n");
  const provider = new PetCoverProvider({assets:root,workerPath,python});
  try {
    assert.equal((await provider.response(COVER_URL,'GET'))?.status,404);
    const pid=Number(await readFile(join(root,'pid'),'utf8'));
    assert.throws(()=>process.kill(pid,0));
  } finally { await provider.close(); await rm(root,{recursive:true,force:true}); }
});
