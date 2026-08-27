// Throwaway visual-verification script: launches the built extension and
// screenshots each surface in light and dark. Not part of the test suite.
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.output/chrome-mv3');
const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node ui-shots.mjs <outDir>');
await fs.mkdir(outDir, { recursive: true });

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scribetab-shots-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ],
});
await context.route(/^(https?|wss?):\/\//i, (route) => route.abort());
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
const url = (p) => `chrome-extension://${extensionId}/${p}`;

// First load creates the IndexedDB schema via the app's own openDb().
await page.goto(url('sidepanel.html'));
await page.waitForSelector('[data-testid="sidepanel-root"]');

// Seed sessions + segments.
await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('scribetab');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const month = new Date();
  const iso = (day, h) => new Date(month.getFullYear(), month.getMonth(), day, h).toISOString();
  const sessions = [
    {
      id: 's-roadmap', title: 'Roadmap review', startedAt: iso(27, 14), endedAt: iso(27, 14.55),
      platform: 'meet', status: 'complete', costUsd: 0.11,
      summaryMarkdown: 'Export flow ships this sprint: design signed off Tuesday, the open pagination bug is not a blocker. Cut planned for Thursday with a staged rollout.\n\nAction items:\n- Eng to close pagination bug before Thursday\n- Draft staged rollout plan (platform team)',
    },
    { id: 's-design', title: 'Design sync with Priya', startedAt: iso(26, 11.5), endedAt: iso(26, 12.3), platform: 'meet', status: 'complete', costUsd: 0.19 },
    { id: 's-cust', title: 'Customer call — Meridian Corp', startedAt: iso(25, 16.25), endedAt: iso(25, 16.7), platform: 'zoom', status: 'complete', costUsd: 0.12 },
  ];
  const segs = [
    { id: 'g1', sessionId: 's-roadmap', startMs: 4000, endMs: 18000, text: "Okay, I think everyone's here, so let's get started with the roadmap review.", source: 'audio' },
    { id: 'g2', sessionId: 's-roadmap', startMs: 19000, endMs: 40000, text: 'The main thing we need to decide today is whether the export flow ships this sprint or next.', source: 'audio' },
    { id: 'g3', sessionId: 's-roadmap', startMs: 41000, endMs: 61000, text: "From the design side we're ready, the mockups were signed off on Tuesday.", source: 'audio' },
    { id: 'g4', sessionId: 's-roadmap', startMs: 62000, endMs: 78000, text: "Engineering still has the pagination bug open, but it shouldn't block the release.", source: 'audio' },
  ];
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'segments'], 'readwrite');
    for (const s of sessions) tx.objectStore('sessions').put(s);
    for (const s of segs) tx.objectStore('segments').put(s);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
});

async function shot(name, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log('shot', name);
}

// Popup — idle, light (with month spend from seeded sessions)
await page.emulateMedia({ colorScheme: 'light' });
await page.goto(url('popup.html'));
await page.waitForSelector('[data-testid="popup-root"]');
await shot('popup-idle-light', 340, 600);

// Popup — recording, dark
await worker.evaluate(async () => {
  await chrome.storage.local.set({ captureState: 'recording', currentSessionId: 's-roadmap', chunkCount: 13 });
});
await page.emulateMedia({ colorScheme: 'dark' });
await page.reload();
await page.waitForSelector('[data-testid="popup-root"]');
await shot('popup-recording-dark', 340, 640);

// Side panel — live during recording, dark
await page.goto(url('sidepanel.html'));
await page.waitForSelector('[data-testid="sidepanel-root"]');
await shot('panel-live-dark', 360, 640);

// Back to idle for the rest
await worker.evaluate(async () => {
  await chrome.storage.local.set({ captureState: 'idle', chunkCount: 0 });
  await chrome.storage.local.remove(['currentSessionId']);
});
await page.emulateMedia({ colorScheme: 'light' });

// Side panel — library, light
await page.goto(url('sidepanel.html'));
await page.waitForSelector('[data-testid="sidepanel-root"]');
await page.getByRole('button', { name: 'library' }).click();
await page.waitForSelector('.st-session');
await shot('panel-library-light', 360, 640);

// Side panel — session detail, light
await page.getByRole('button', { name: /Roadmap review/ }).click();
await page.waitForSelector('article');
await shot('panel-detail-light', 360, 760);

// Options — light, with usage card
await page.goto(url('options.html'));
await page.waitForSelector('[data-testid="options-root"]');
await page.waitForSelector('[data-testid="usage-section"]');
await shot('options-light-top', 900, 900);
await page.evaluate(() => document.querySelector('[data-testid="usage-section"]').scrollIntoView());
await shot('options-light-usage', 900, 900);

// Options — dark
await page.emulateMedia({ colorScheme: 'dark' });
await page.evaluate(() => window.scrollTo(0, 0));
await shot('options-dark-top', 900, 900);

await context.close();
await fs.rm(userDataDir, { recursive: true, force: true });
console.log('done');
