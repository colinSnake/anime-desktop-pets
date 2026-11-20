import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COMPANION_COVER_URL, COVER_URL, PetCoverProvider } from '../src/pet-cover.ts';

const valid = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('workspace cover is a single bounded local PNG, cached, with no fallback subprocess', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-cover-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'cover.png');
  const provider = new PetCoverProvider(path);
  await writeFile(path, valid);
  assert.equal(await provider.response(COVER_URL + '?x', 'GET'), undefined);
  assert.equal(await provider.response(COVER_URL, 'POST'), undefined);
  const response = await provider.response(COVER_URL, 'GET');
  assert.equal(response?.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response!.arrayBuffer()), valid);
  await rm(path);
  assert.equal((await provider.response(COVER_URL, 'GET'))?.status, 200);
  assert.equal((await new PetCoverProvider(path).response(COVER_URL, 'GET'))?.status, 404);
  for (const data of [Buffer.alloc(33), Buffer.alloc(1024 * 1024 + 1)]) {
    await writeFile(path, data);
    assert.equal((await new PetCoverProvider(path).response(COVER_URL, 'GET'))?.status, 404);
  }
  if (process.platform !== 'win32') {
    const link = join(root, 'link.png');
    await writeFile(path, valid);
    await symlink(path, link);
    assert.equal((await new PetCoverProvider(link).response(COVER_URL, 'GET'))?.status, 404);
  }
});

test('fixed workspace covers accept 2× artwork without dropping the pixel bound', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-cover-density-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const longmei = join(root, 'longmei.png'), dafeiyu = join(root, 'dafeiyu.png');
  const dimensionHeader = (width: number, height: number) => {
    const data = Buffer.from(valid);
    data.writeUInt32BE(width, 16);
    data.writeUInt32BE(height, 20);
    return data;
  };
  await writeFile(longmei, dimensionHeader(512, 512));
  const companionCover = dimensionHeader(444, 556);
  await writeFile(dafeiyu, companionCover);
  const provider = new PetCoverProvider(longmei, dafeiyu);
  assert.equal((await provider.response(COVER_URL, 'GET'))?.status, 200);
  const response = await provider.response(COMPANION_COVER_URL, 'GET');
  assert.equal(response?.status, 200);
  assert.deepEqual(Buffer.from(await response!.arrayBuffer()), companionCover);
  for (const data of [dimensionHeader(444, 557), dimensionHeader(557, 444), dimensionHeader(0, 556)]) {
    await writeFile(dafeiyu, data);
    assert.equal((await new PetCoverProvider(longmei, dafeiyu).response(COMPANION_COVER_URL, 'GET'))?.status, 404);
  }
});
