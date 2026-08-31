import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from '../utils/db';
import {
  deleteHighlight,
  deleteHighlightsForSession,
  getAllHighlights,
  getHighlightsForSession,
  putHighlight,
  updateHighlightLabel,
} from '../utils/highlightStore';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('scribetab');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('delete blocked'));
  });
}

beforeEach(async () => { await closeDb(); await deleteDb(); });
afterEach(async () => { await closeDb(); await deleteDb(); });

describe('highlightStore', () => {
  it('supports ordered session reads and label updates', async () => {
    await putHighlight({ id: 'late', sessionId: 's1', startMs: 200, createdAt: 't' });
    await putHighlight({ id: 'early', sessionId: 's1', startMs: 100, createdAt: 't' });
    await putHighlight({ id: 'other', sessionId: 's2', startMs: 0, createdAt: 't' });
    expect((await getHighlightsForSession('s1')).map((h) => h.id)).toEqual(['early', 'late']);
    await updateHighlightLabel((await getHighlightsForSession('s1'))[0]!, '  Important  ');
    expect((await getHighlightsForSession('s1'))[0]?.label).toBe('Important');
    expect((await getAllHighlights()).map((h) => h.id)).toHaveLength(3);
  });

  it('deletes only the requested highlight and session highlights', async () => {
    await putHighlight({ id: 'one', sessionId: 's1', startMs: 0, createdAt: 't' });
    await putHighlight({ id: 'two', sessionId: 's1', startMs: 1, createdAt: 't' });
    await putHighlight({ id: 'three', sessionId: 's2', startMs: 2, createdAt: 't' });
    await deleteHighlight('s2', 'one');
    expect((await getHighlightsForSession('s1')).map((h) => h.id)).toEqual(['one', 'two']);
    await deleteHighlightsForSession('s1');
    expect((await getAllHighlights()).map((h) => h.id)).toEqual(['three']);
  });

  it('persists the kind and backfills the default for legacy rows', async () => {
    await putHighlight({ id: 'k', sessionId: 's1', startMs: 0, createdAt: 't', kind: 'decision' });
    await putHighlight({ id: 'bad', sessionId: 's1', startMs: 1, createdAt: 't', kind: 'bogus' as never });
    // Legacy row written raw, before kinds existed in the schema.
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('highlights', 'readwrite');
      tx.objectStore('highlights').put({ id: 'legacy', sessionId: 's1', startMs: 2, createdAt: 't' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await closeDb();
    const rows = await getHighlightsForSession('s1');
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ['k', 'decision'],
      ['bad', 'highlight'],
      ['legacy', 'highlight'],
    ]);
    expect((await getAllHighlights()).map((r) => r.kind)).toContain('highlight');
    // Kind survives label edits.
    await updateHighlightLabel(rows[0]!, 'note');
    expect((await getHighlightsForSession('s1'))[0]?.kind).toBe('decision');
  });
});
