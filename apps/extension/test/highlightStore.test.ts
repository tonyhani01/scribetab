import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../utils/db';
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
});
