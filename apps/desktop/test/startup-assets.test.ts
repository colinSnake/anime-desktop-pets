import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startupResponse } from '../src/startup-assets.ts';

const videoURL = 'pet-startup://player/startup.mp4';
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'startup-video-fixture-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('fixed startup assets enforce a separate CSP, and stream a full MP4 or one valid byte interval', async () => fixture(async dir => {
  await writeFile(join(dir, 'index.html'), '<video>synthetic</video>');
  await writeFile(join(dir, 'startup.mp4'), '0123456789');
  const page = await startupResponse(dir, new Request('pet-startup://player/index.html'));
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /media-src 'self'.*connect-src 'none'/);
  assert.equal(await page.text(), '<video>synthetic</video>');
  const full = await startupResponse(dir, new Request(videoURL));
  assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal(await full.text(), '0123456789');
  for (const [range, expected, payload] of [['bytes=3-6', 'bytes 3-6/10', '3456'], ['bytes=8-', 'bytes 8-9/10', '89'], ['bytes=-3', 'bytes 7-9/10', '789']]) {
    const media = await startupResponse(dir, new Request(videoURL, { headers: { range: range! } }));
    assert.equal(media.status, 206); assert.equal(media.headers.get('content-range'), expected); assert.equal(await media.text(), payload);
  }
}));

test('unknown paths and methods are denied; malformed ranges never read media', async () => fixture(async dir => {
  await writeFile(join(dir, 'startup.mp4'), '1234');
  for (const url of ['pet-startup://workspace/startup.mp4', 'pet-startup://player/secret.mp4', `${videoURL}?file=x`])
    assert.equal((await startupResponse(dir, new Request(url))).status, 404);
  assert.equal((await startupResponse(dir, new Request(videoURL, { method: 'POST' }))).status, 404);
  for (const range of ['bytes=4-', 'bytes=1-0', 'bytes=0-1,2-3', 'bytes=-0', `bytes=${'9'.repeat(80)}-`]) {
    const response = await startupResponse(dir, new Request(videoURL, { headers: { range } }));
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */4');
  }
}));

test('missing, symlinked, non-regular, and oversized videos are unavailable', async () => fixture(async dir => {
  const path = join(dir, 'startup.mp4');
  const check = async () => assert.equal((await startupResponse(dir, new Request(videoURL))).status, 404);
  await check();
  if (process.platform !== 'win32') {
    await writeFile(join(dir, 'private.mp4'), 'synthetic'); await symlink(join(dir, 'private.mp4'), path);
    await check(); await rm(path);
  }
  await mkdir(path); await check(); await rm(path, { recursive: true });
  await writeFile(path, ''); await truncate(path, 128 * 1024 * 1024 + 1); await check();
}));
