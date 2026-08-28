/**
 * One-click data wipe: API keys, settings, and every IndexedDB store.
 * Used by the options page "Wipe all data" button. Does not touch
 * chrome.storage.session keys (consent dismissals die with the browser anyway).
 */

import { closeDb } from './db';

const STORAGE_KEYS_TO_CLEAR = [
  'settings',
  'apiKey',
  'apiKeys',
  'llmApiKey',
  'llmApiKeys',
  'currentSessionId',
  'captureState',
  'capturedTabId',
  'sessionCaptionsOnly',
  'lastError',
  'lastTranscriptionError',
  'captureNotice',
  'chunkCount',
  'transcribedCount',
  'segmentCount',
  'nativeHostStatus',
  'quotaWarning',
  'transcriptionConfigured',
  'transcriptionIssue',
  'micStatus',
  'audioStartedAtMs',
];

/** Databases opened by the extension. Adding a DB? Add it here. */
const DB_NAMES = ['scribetab'];

export async function wipeAllData(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS_TO_CLEAR);
  await closeDb();
  await Promise.all(DB_NAMES.map((name) => dropDatabase(name)));
}

function dropDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Deleting while our memoized connection is open would block; a fresh
    // open afterwards recreates empty stores on demand.
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`Failed to delete database: ${name}`));
    req.onblocked = () => reject(new Error(`Database deletion blocked: ${name}`));
  });
}
