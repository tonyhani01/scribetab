import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.output/chrome-mv3');

async function launchExtension(): Promise<{
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  userDataDir: string;
}> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scribetab-e2e-'));
  // Block network at process start (before the SW can fetch). context.route
  // below is a second gate for anything that bypasses DNS.
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
  return { context, extensionId, worker, userDataDir };
}

test.describe.configure({ mode: 'serial' });

test('extension loads and the service worker registers', async () => {
  const { context, worker, userDataDir } = await launchExtension();
  try {
    expect(worker.url()).toMatch(/^chrome-extension:\/\//);
    await expect.poll(() => worker.evaluate(() => chrome.runtime.id)).not.toBe('');
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('popup renders', async () => {
  const { context, extensionId, userDataDir } = await launchExtension();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.getByTestId('popup-root')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ScribeTab' })).toBeVisible();
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('options saves a setting', async () => {
  const { context, extensionId, worker, userDataDir } = await launchExtension();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.getByTestId('options-root')).toBeVisible();
    const box = page.getByTestId('retain-audio');
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByTestId('save-settings').click();
    await expect(page.getByTestId('save-status')).toContainText('Saved');
    const stored = await worker.evaluate(async () => {
      const v = await chrome.storage.local.get('settings');
      return (v.settings as { retainAudio?: boolean } | undefined)?.retainAudio;
    });
    expect(stored).toBe(false);
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('side panel shows the empty live state', async () => {
  const { context, extensionId, userDataDir } = await launchExtension();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(page.getByTestId('sidepanel-root')).toBeVisible();
    await expect(page.getByTestId('live-empty')).toBeVisible();
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('consent banner appears in the popup during a fake recording', async () => {
  const { context, extensionId, worker, userDataDir } = await launchExtension();
  try {
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        captureState: 'recording',
        currentSessionId: 'e2e-consent',
      });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.getByTestId('consent-banner')).toBeVisible();
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('options blocks save when a cloud STT key is empty', async () => {
  const { context, extensionId, worker, userDataDir } = await launchExtension();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.getByTestId('options-root')).toBeVisible();
    await page.locator('#provider').selectOption('openai');
    await page.getByTestId('save-settings').click();
    await expect(page.getByTestId('save-status')).toContainText(/API key/i);
    const stored = await worker.evaluate(async () => {
      const v = await chrome.storage.local.get('settings');
      return (v.settings as { providerId?: string } | undefined)?.providerId;
    });
    expect(stored).not.toBe('openai');
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
