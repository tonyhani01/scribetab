/**
 * Unit tests for scripts/release-checks.mjs (node:test, no npm deps).
 * Run: node --test scripts/release-checks.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG_SIGNATURE, pngDimensions, parseZipListing, runChecks } from './release-checks.mjs';

// ---- helpers ----------------------------------------------------------------

/** Minimal PNG: signature + IHDR chunk with the given dimensions (no CRC check needed). */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const length = Buffer.alloc(4);
  length.writeUInt32BE(ihdr.length, 0);
  const crc = Buffer.alloc(4); // zeros; pngDimensions does not validate CRC
  return Buffer.concat([PNG_SIGNATURE, length, Buffer.from('IHDR', 'latin1'), ihdr, crc]);
}

/** filename -> [width, height] every good fixture must provide. */
const ALL_ASSETS = [
  ['icon-128.png', 128, 128],
  ['popup-1280x800.png', 1280, 800],
  ['options-full-1280x800.png', 1280, 800],
  ['sidepanel-library-1280x800.png', 1280, 800],
  ['sidepanel-live-1280x800.png', 1280, 800],
  ['promo-small-440x280.png', 440, 280],
  ['promo-marquee-1400x560.png', 1400, 560],
];

const GOOD_MANIFEST = {
  version: '1.1.0',
  name: 'ScribeTab',
  description: 'Session-based tab manager for Chrome.',
  permissions: ['storage', 'tabs'],
  host_permissions: ['https://example.com/*'],
  content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
};

/**
 * Temp fixture dir: docs/store-assets PNGs + built manifest.json.
 * The zip is intentionally absent (tests never require the `unzip` binary),
 * so a healthy fixture reports only the missing-zip failure.
 */
async function makeFixture(t, { manifest = GOOD_MANIFEST, omitAssets = [], overrideAssets = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'release-checks-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const assetsDir = join(root, 'docs', 'store-assets');
  await mkdir(assetsDir, { recursive: true });
  for (const [fileName, width, height] of ALL_ASSETS) {
    if (omitAssets.includes(fileName)) continue;
    const [w, h] = overrideAssets[fileName] ?? [width, height];
    await writeFile(join(assetsDir, fileName), makePng(w, h));
  }

  const outDir = join(root, 'apps', 'extension', '.output', 'chrome-mv3');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return root;
}

// ---- pngDimensions ----------------------------------------------------------

test('pngDimensions parses width/height from the IHDR chunk', () => {
  for (const [w, h] of [[3, 4], [128, 128], [1280, 800], [1400, 560], [65535, 1]]) {
    assert.deepEqual(pngDimensions(makePng(w, h)), { width: w, height: h });
  }
});

test('pngDimensions throws on non-PNG or truncated buffers', () => {
  assert.throws(() => pngDimensions(Buffer.from('definitely not a png')), /not a PNG/i);
  assert.throws(() => pngDimensions(Buffer.alloc(0)), /not a PNG/i);
  assert.throws(
    () => pngDimensions(Buffer.concat([PNG_SIGNATURE, Buffer.from('truncated')])),
    /not a PNG/i
  );
  // Valid signature but first chunk is not IHDR.
  const fake = Buffer.concat([
    PNG_SIGNATURE,
    Buffer.alloc(4), Buffer.from('IDAT', 'latin1'), Buffer.alloc(13),
  ]);
  assert.throws(() => pngDimensions(fake), /not a PNG/i);
  assert.throws(() => pngDimensions('not a buffer at all'), TypeError);
});

// ---- parseZipListing ----------------------------------------------------------

const UNZIP_LISTING = [
  'Archive:  scribetab-1.1.0-chrome.zip',
  '  Length      Date    Time    Name',
  '---------  ---------- -----   ----',
  '     1013  01-15-2025 09:30   manifest.json',
  '     2048  01-15-2025 09:30   background.js',
  '     4096  01-15-2025 09:30   content/content.js',
  '      888  01-15-2025 09:30   content/content.js.map',
  '      128  01-15-2025 09:30   .DS_Store',
  '     6144  01-15-2025 09:30   icons/icon-128.png',
  '---------                     -------',
  '    14317                     6 files',
  '',
].join('\n');

test('parseZipListing extracts entry paths, skipping header/footer lines', () => {
  const paths = parseZipListing(UNZIP_LISTING);
  assert.deepEqual(paths, [
    'manifest.json',
    'background.js',
    'content/content.js',
    'content/content.js.map',
    '.DS_Store',
    'icons/icon-128.png',
  ]);
});

test('parseZipListing output feeds .map / .DS_Store detection; ISO dates also parse', () => {
  const paths = parseZipListing(UNZIP_LISTING);
  assert.deepEqual(paths.filter((p) => p.toLowerCase().endsWith('.map')), ['content/content.js.map']);
  assert.deepEqual(paths.filter((p) => p.includes('.DS_Store')), ['.DS_Store']);

  const isoListing = [
    'Archive:  x.zip',
    '  Length      Date    Time    Name',
    '---------  ---------- -----   ----',
    '     1013  2025-01-15 09:30   manifest.json',
    '---------                     -------',
    '     1013                     1 file',
    '',
  ].join('\n');
  assert.deepEqual(parseZipListing(isoListing), ['manifest.json']);
  assert.deepEqual(parseZipListing(''), []);
});

// ---- runChecks ---------------------------------------------------------------

test('runChecks: good fixture passes asset + manifest checks (only zip missing)', async (t) => {
  const root = await makeFixture(t);
  const res = await runChecks({ rootDir: root, expectedVersion: '1.1.0' });
  assert.equal(res.failures.filter((f) => f.startsWith('store assets:')).length, 0);
  assert.equal(res.failures.filter((f) => f.startsWith('manifest:')).length, 0);
  assert.ok(res.failures.length >= 1, 'zip absence must still be reported');
  assert.ok(res.failures.every((f) => f.startsWith('zip:')), `unexpected failures: ${res.failures}`);
  assert.equal(res.ok, false);
  assert.ok(res.checks > 0);
});

test('runChecks reports version mismatch against expectedVersion', async (t) => {
  const root = await makeFixture(t, { manifest: { ...GOOD_MANIFEST, version: '9.9.9' } });
  const res = await runChecks({ rootDir: root, expectedVersion: '1.1.0' });
  const hit = res.failures.find(
    (f) => f.startsWith('manifest:') && f.includes('version') && f.includes('9.9.9') && f.includes('1.1.0')
  );
  assert.ok(hit, `expected a version-mismatch failure, got: ${res.failures}`);
});

test('runChecks reports an over-long description (>132 chars)', async (t) => {
  const root = await makeFixture(t, {
    manifest: { ...GOOD_MANIFEST, description: 'x'.repeat(140) },
  });
  const res = await runChecks({ rootDir: root, expectedVersion: '1.1.0' });
  const hit = res.failures.find((f) => f.startsWith('manifest:') && f.includes('description'));
  assert.ok(hit, `expected a description failure, got: ${res.failures}`);
  assert.ok(hit.includes('140') && hit.includes('132'), `failure lacks lengths: ${hit}`);
});

test('runChecks reports localhost/127.0.0.1 in host_permissions and content_scripts matches', async (t) => {
  const root = await makeFixture(t, {
    manifest: {
      ...GOOD_MANIFEST,
      host_permissions: ['https://example.com/*', 'http://localhost:5173/*'],
      content_scripts: [{ matches: ['http://127.0.0.1:8080/*'], js: ['content.js'] }],
    },
  });
  const res = await runChecks({ rootDir: root, expectedVersion: '1.1.0' });
  const hostHit = res.failures.find((f) => f.includes('host_permissions') && f.includes('localhost'));
  const csHit = res.failures.find((f) => f.includes('content_scripts[0].matches') && f.includes('127.0.0.1'));
  assert.ok(hostHit, `expected host_permissions failure, got: ${res.failures}`);
  assert.ok(csHit, `expected content_scripts failure, got: ${res.failures}`);
});

test('runChecks reports a missing store asset', async (t) => {
  const root = await makeFixture(t, { omitAssets: ['icon-128.png'] });
  const res = await runChecks({ rootDir: root, expectedVersion: '1.1.0' });
  const hit = res.failures.find((f) => f.startsWith('store assets:') && f.includes('icon-128.png'));
  assert.ok(hit, `expected a missing-asset failure, got: ${res.failures}`);
  assert.ok(hit.toLowerCase().includes('missing'), `failure lacks actionable hint: ${hit}`);
  assert.ok(!res.failures.some((f) => f.includes('promo-small-440x280.png')), 'unrelated assets should pass');
});

test('runChecks reports wrong store asset dimensions', async (t) => {
  const root = await makeFixture(t, { overrideAssets: { 'icon-128.png': [64, 64] } });
  const res = await runChecks({ rootDir: root, expectedVersion: '1.1.0' });
  const hit = res.failures.find((f) => f.startsWith('store assets:') && f.includes('icon-128.png'));
  assert.ok(hit, `expected a dimension failure, got: ${res.failures}`);
  assert.ok(hit.includes('64x64') && hit.includes('128x128'), `failure lacks dims: ${hit}`);
});
