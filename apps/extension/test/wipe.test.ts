import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb } from '../utils/db';
import { putChunk } from '../utils/chunkStore';
import { putHighlight } from '../utils/highlightStore';
import { createSession } from '../utils/sessionStore';
import { wipeAllData } from '../utils/wipe';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('delete blocked'));
  });
}

beforeEach(async () => {
  vi.stubGlobal('chrome', { storage: { local: { remove: vi.fn().mockResolvedValue(undefined) } } });
  await closeDb();
  await deleteDb();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDb();
  await deleteDb();
});

describe('wipeAllData', () => {
  it('requests storage cleanup and deletes real IndexedDB data before resolving', async () => {
    await createSession({ id: 's1', title: 'n', startedAt: '2026-08-01T00:00:00Z', platform: 'other', status: 'complete' });
    await putChunk({ sessionId: 's1', index: 0, sampleRate: 16_000, startOffsetSamples: 0, wav: new ArrayBuffer(1), createdAt: 1 });
    await putHighlight({ id: 'h1', sessionId: 's1', startMs: 0, createdAt: 't' });
    const remove = (chrome.storage.local.remove as ReturnType<typeof vi.fn>);
    await wipeAllData();
    expect(remove).toHaveBeenCalledWith(expect.arrayContaining(['settings', 'currentSessionId', 'audioStartedAtMs']));
    const db = await openDb();
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['sessions', 'audioChunks', 'highlights']));
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(['sessions', 'audioChunks', 'highlights'], 'readonly');
      const out: unknown[] = [];
      for (const name of ['sessions', 'audioChunks', 'highlights']) {
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => out.push(...req.result);
        req.onerror = () => reject(req.error);
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
    expect(rows).toEqual([]);
  });
});
