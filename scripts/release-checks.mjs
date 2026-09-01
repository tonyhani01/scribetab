#!/usr/bin/env node
/**
 * Chrome Web Store preflight checks for ScribeTab.
 *
 * Verifies, without building or uploading anything:
 *   1. Store assets in docs/store-assets/ exist with the exact dimensions
 *      their filenames imply (icon-128.png is 128x128; *-<w>x<h>.png is w x h).
 *   2. The built MV3 manifest (apps/extension/.output/chrome-mv3/manifest.json)
 *      has the expected version, a usable name/description (<=132 chars), and
 *      no dev URLs (localhost / 127.0.0.1) in permissions, host_permissions,
 *      or content_scripts[].matches.
 *   3. The packaged zip (apps/extension/.output/scribetab-<version>-chrome.zip)
 *      exists and contains no sourcemaps (.map) or .DS_Store entries.
 *
 * Usage:
 *   node scripts/release-checks.mjs [--version x.y.z]
 *
 * --version defaults to the version in apps/extension/package.json.
 * Exits 1 if any check fails, 2 on usage/config errors.
 * Pure Node stdlib — no npm dependencies.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const execFileAsync = promisify(execFile);

/** 8-byte signature every PNG file must start with. */
export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const MAX_DESCRIPTION_LENGTH = 132;
const LOCALHOST_RE = /localhost|127\.0\.0\.1/i;
const ZIP_HINT = 'run pnpm --filter @scribetab/extension zip first';
const ASSETS_HINT = 'restore docs/store-assets/ from version control (git checkout -- docs/store-assets)';

/** Store assets tracked in docs/store-assets/ (see docs/store-assets/). */
const STORE_ASSETS = [
  'icon-128.png',
  'popup-1280x800.png',
  'options-full-1280x800.png',
  'sidepanel-library-1280x800.png',
  'sidepanel-live-1280x800.png',
  'promo-small-440x280.png',
  'promo-marquee-1400x560.png',
];

/**
 * Parse image dimensions from a PNG buffer's IHDR chunk.
 * Validates the 8-byte PNG signature and that the first chunk is IHDR;
 * width/height are big-endian uint32 at byte offsets 16 and 20.
 * Throws on non-PNG or truncated input.
 */
export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('pngDimensions expects a Buffer');
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file: bad signature');
  }
  if (buffer.length < 24) {
    throw new Error('not a PNG file: truncated before IHDR dimensions');
  }
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG file: first chunk is not IHDR');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Extract file paths from `unzip -l` output. Skips the header
 * ("Length/Date/Time/Name"), the dash separators, and the footer totals.
 * Accepts both MM-DD-YYYY (Info-ZIP) and YYYY-MM-DD (busybox) date formats.
 */
export function parseZipListing(text) {
  const paths = [];
  if (typeof text !== 'string') return paths;
  const entryRe = /^\s*\d+\s+(?:\d{2}-\d{2}-\d{2,4}|\d{4}-\d{2}-\d{2})\s+\d{1,2}:\d{2}\s+(.+)$/;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(entryRe);
    if (match) paths.push(match[1].trimEnd());
  }
  return paths;
}

/** Expected dimensions parsed from a store-asset filename, or null if unparseable. */
function expectedAssetDimensions(fileName) {
  const wxh = fileName.match(/(\d+)x(\d+)\.png$/i);
  if (wxh) return { width: Number(wxh[1]), height: Number(wxh[2]) };
  const icon = fileName.match(/^icon-(\d+)\.png$/i);
  if (icon) {
    const size = Number(icon[1]);
    return { width: size, height: size };
  }
  return null;
}

/** Collect strings containing localhost/127.0.0.1 under `value` into `out`. */
function scanLocalhost(value, label, out) {
  if (typeof value === 'string') {
    if (LOCALHOST_RE.test(value)) out.push({ path: label, value });
  } else if (Array.isArray(value)) {
    value.forEach((entry, i) => scanLocalhost(entry, `${label}[${i}]`, out));
  }
}

/**
 * Run all Chrome Web Store preflight checks.
 *
 * @param {object} options
 * @param {string} options.rootDir  Repo root (contains docs/ and apps/).
 * @param {string} options.expectedVersion  Version the build must match.
 * @returns {Promise<{ok: boolean, failures: string[], checks: number}>}
 *   `ok` is true iff `failures` is empty; `checks` is the number of checks run.
 *   Never throws for a failed check — every problem is collected as a
 *   human-readable line in `failures`.
 */
export async function runChecks({ rootDir, expectedVersion }) {
  if (typeof rootDir !== 'string' || !rootDir) {
    throw new TypeError('runChecks: rootDir is required');
  }
  if (typeof expectedVersion !== 'string' || !expectedVersion) {
    throw new TypeError('runChecks: expectedVersion is required');
  }

  const root = resolve(rootDir);
  const rel = (p) => relative(root, p) || '.';
  const failures = [];
  let checks = 0;
  const pass = () => { checks += 1; };
  const fail = (message) => { checks += 1; failures.push(message); };

  // ---- 1. Store assets ----------------------------------------------------
  const assetsDir = join(root, 'docs', 'store-assets');
  let assetsDirOk = false;
  try {
    const st = await stat(assetsDir);
    if (st.isDirectory()) {
      assetsDirOk = true;
    } else {
      fail(`store assets: ${rel(assetsDir)} is not a directory — ${ASSETS_HINT}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(`store assets: directory ${rel(assetsDir)} is missing — ${ASSETS_HINT}`);
    } else {
      fail(`store assets: could not inspect ${rel(assetsDir)}: ${err.message}`);
    }
  }

  if (assetsDirOk) {
    for (const fileName of STORE_ASSETS) {
      const filePath = join(assetsDir, fileName);
      let buffer;
      try {
        buffer = await readFile(filePath);
      } catch {
        fail(`store assets: ${rel(filePath)} is missing — ${ASSETS_HINT}`);
        continue;
      }
      pass(); // existence

      const expected = expectedAssetDimensions(fileName);
      if (!expected) {
        fail(`store assets: ${fileName}: cannot infer expected dimensions from filename`);
        continue;
      }
      let dims;
      try {
        dims = pngDimensions(buffer);
      } catch (err) {
        fail(`store assets: ${rel(filePath)} is not a valid PNG (${err.message})`);
        continue;
      }
      pass(); // parseable PNG
      if (dims.width !== expected.width || dims.height !== expected.height) {
        fail(
          `store assets: ${rel(filePath)} is ${dims.width}x${dims.height}, ` +
          `expected ${expected.width}x${expected.height}`
        );
      } else {
        pass(); // dimensions
      }
    }
  }

  // ---- 2. Built manifest --------------------------------------------------
  const manifestPath = join(root, 'apps', 'extension', '.output', 'chrome-mv3', 'manifest.json');
  let manifestRaw = null;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
    pass(); // existence
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(`manifest: ${rel(manifestPath)} not found — ${ZIP_HINT}`);
    } else {
      fail(`manifest: could not read ${rel(manifestPath)}: ${err.message}`);
    }
  }

  let manifest = null;
  if (manifestRaw !== null) {
    try {
      manifest = JSON.parse(manifestRaw);
      pass(); // parse
    } catch (err) {
      fail(`manifest: invalid JSON in ${rel(manifestPath)}: ${err.message}`);
    }
  }

  if (manifest) {
    if (manifest.version !== expectedVersion) {
      fail(
        `manifest: version ${JSON.stringify(manifest.version ?? null)} != expected ` +
        `${JSON.stringify(expectedVersion)} — update apps/extension/package.json and rebuild`
      );
    } else {
      pass();
    }

    const name = manifest.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      fail('manifest: "name" is missing or empty');
    } else {
      pass();
    }

    const description = manifest.description;
    if (typeof description !== 'string' || description.trim().length === 0) {
      fail('manifest: "description" is missing or empty');
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      fail(
        `manifest: "description" is ${description.length} chars ` +
        `(max ${MAX_DESCRIPTION_LENGTH}) — shorten it`
      );
    } else {
      pass();
    }

    const offenders = [];
    scanLocalhost(manifest.permissions, 'permissions', offenders);
    scanLocalhost(manifest.host_permissions, 'host_permissions', offenders);
    (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []).forEach(
      (script, i) => scanLocalhost(script?.matches, `content_scripts[${i}].matches`, offenders)
    );
    if (offenders.length > 0) {
      for (const { path, value } of offenders) {
        fail(
          `manifest: dev URL ${JSON.stringify(value)} in ${path} — ` +
          'localhost/127.0.0.1 must not ship to the store'
        );
      }
    } else {
      pass();
    }
  }

  // ---- 3. Packaged zip ----------------------------------------------------
  const zipPath = join(
    root, 'apps', 'extension', '.output', `scribetab-${expectedVersion}-chrome.zip`
  );
  let zipExists = false;
  try {
    const st = await stat(zipPath);
    if (st.isFile()) {
      zipExists = true;
      pass();
    } else {
      fail(`zip: ${rel(zipPath)} is not a regular file — ${ZIP_HINT}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(`zip: ${rel(zipPath)} not found — ${ZIP_HINT}`);
    } else {
      fail(`zip: could not inspect ${rel(zipPath)}: ${err.message}`);
    }
  }

  if (zipExists) {
    let listingText = null;
    try {
      const { stdout } = await execFileAsync('unzip', ['-l', zipPath], {
        maxBuffer: 10 * 1024 * 1024,
      });
      listingText = stdout;
    } catch (err) {
      if (err.code === 'ENOENT') {
        fail('zip: `unzip` binary not found on PATH — install unzip to enable package hygiene checks');
      } else {
        const detail = (err.stderr || err.message || '').trim().split('\n')[0];
        fail(`zip: \`unzip -l ${rel(zipPath)}\` failed: ${detail}`);
      }
    }

    if (listingText !== null) {
      const entries = parseZipListing(listingText);
      if (entries.length === 0) {
        fail(`zip: \`unzip -l\` returned no entries — ${rel(zipPath)} may be corrupt`);
      } else {
        pass(); // listing parsed
        const maps = entries.filter((e) => e.toLowerCase().endsWith('.map'));
        if (maps.length > 0) {
          fail(
            `zip: sourcemap entries must not ship: ` +
            maps.slice(0, 5).join(', ') + (maps.length > 5 ? ` (+${maps.length - 5} more)` : '')
          );
        } else {
          pass();
        }
        const dsStore = entries.filter((e) => e.includes('.DS_Store'));
        if (dsStore.length > 0) {
          fail(
            `zip: .DS_Store entries must not ship: ` +
            dsStore.slice(0, 5).join(', ') + (dsStore.length > 5 ? ` (+${dsStore.length - 5} more)` : '')
          );
        } else {
          pass();
        }
      }
    }
  }

  return { ok: failures.length === 0, failures, checks };
}

// ---- CLI -------------------------------------------------------------------

const USAGE = 'Usage: node scripts/release-checks.mjs [--version x.y.z]';

async function readDefaultVersion(rootDir) {
  const pkgPath = join(rootDir, 'apps', 'extension', 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    throw new Error('"version" field is missing or empty');
  } catch (err) {
    console.error(`release-checks: cannot read default version from ${pkgPath}: ${err.message}`);
    return null;
  }
}

async function main(argv) {
  let expectedVersion = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        console.error('release-checks: --version requires a value like 1.2.3');
        console.error(USAGE);
        return 2;
      }
      expectedVersion = value;
    } else if (arg.startsWith('--version=')) {
      expectedVersion = arg.slice('--version='.length);
    } else {
      console.error(`release-checks: unknown argument ${JSON.stringify(arg)}`);
      console.error(USAGE);
      return 2;
    }
  }

  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  if (!expectedVersion) {
    expectedVersion = await readDefaultVersion(rootDir);
    if (!expectedVersion) return 2;
  }

  const { ok, failures, checks } = await runChecks({ rootDir, expectedVersion });
  if (ok) {
    console.log(`OK (${checks} checks)`);
    return 0;
  }
  for (const failure of failures) console.log(failure);
  console.log(`${failures.length} of ${checks} checks failed`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
