import MiniSearch from 'minisearch';

export interface SearchDoc {
  id: string;
  sessionId: string;
  startMs: number;
  text: string;
  sessionTitle: string;
}

export function createSegmentIndex(docs: SearchDoc[]): MiniSearch<SearchDoc> {
  const mini = new MiniSearch<SearchDoc>({
    fields: ['text', 'sessionTitle'],
    storeFields: ['sessionId', 'startMs', 'text', 'sessionTitle'],
    searchOptions: { prefix: true, fuzzy: 0.2 },
  });
  mini.addAll(docs);
  return mini;
}

export function snippetAround(text: string, query: string, radius = 42): string {
  const q = query.trim();
  if (!q || !text) return text.slice(0, radius * 2);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
