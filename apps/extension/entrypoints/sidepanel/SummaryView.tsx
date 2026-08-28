import { actionItemLine, type ExportActionsAck, type SessionSummary } from '@scribetab/shared';
import { useEffect, useState } from 'preact/hooks';
import type { StoredSession } from '@/utils/sessionStore';
import { nextSelection } from '@/utils/actionExport';

export function SummaryView({
  sessionId,
  summary,
  exports,
  busy,
  onExport,
}: {
  sessionId: string;
  summary: SessionSummary;
  exports: NonNullable<StoredSession['actionExports']>;
  busy: boolean;
  onExport: (itemIds: string[]) => Promise<ExportActionsAck | undefined>;
}) {
  const initialSel = () =>
    new Set(summary.actionItems.filter((a) => !exports[a.id]).map((a) => a.id));
  const [sel, setSel] = useState<Set<string>>(initialSel);
  const [lastResults, setLastResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [retryCount, setRetryCount] = useState<number | null>(null);

  useEffect(() => {
    setSel(new Set(summary.actionItems.filter((a) => !exports[a.id]).map((a) => a.id)));
    setLastResults({});
    setRetryCount(null);
  }, [sessionId, summary.generatedAt]);

  const sec = { fontSize: 13, margin: '0 0 4px', fontWeight: 600 };
  return (
    <div style={{ background: '#f6f6f6', padding: 8, fontSize: 13, marginBottom: 12 }}>
      {summary.degraded && (
        <p style={{ color: '#a60', fontSize: 12, margin: '0 0 6px' }}>
          Structured extraction failed — showing plain summary.
        </p>
      )}
      {summary.narrative && <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>{summary.narrative}</p>}
      {summary.actionItems.length > 0 && (
        <>
          <h2 style={sec}>Action items</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
            {summary.actionItems.map((a) => {
              const exported = Boolean(exports[a.id]);
              const fail = lastResults[a.id] && !lastResults[a.id]!.ok ? lastResults[a.id]!.error : undefined;
              return (
                <li key={a.id} style={{ marginBottom: 4 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <input
                      type="checkbox"
                      disabled={exported || busy}
                      checked={exported ? false : sel.has(a.id)}
                      onChange={(e) => {
                        const on = (e.currentTarget as HTMLInputElement).checked;
                        setRetryCount(null);
                        setSel((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(a.id);
                          else next.delete(a.id);
                          return next;
                        });
                      }}
                    />
                    <span>{actionItemLine(a)}</span>
                    {exported && (
                      <span
                        style={{
                          fontSize: 10,
                          color: '#2a7',
                          border: '1px solid #2a7',
                          borderRadius: 3,
                          padding: '0 3px',
                        }}
                      >
                        exported
                      </span>
                    )}
                  </label>
                  {fail && (
                    <p style={{ color: 'crimson', fontSize: 11, margin: '2px 0 0 22px' }}>{fail}</p>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            disabled={busy || sel.size === 0}
            onClick={() => {
              void (async () => {
                const ack = await onExport([...sel]);
                if (!ack) return;
                const map: Record<string, { ok: boolean; error?: string }> = {};
                for (const r of ack.results) map[r.id] = r;
                setLastResults(map);
                const next = nextSelection(sel, ack);
                setSel(next.sel);
                setRetryCount(next.retryCount);
              })();
            }}
          >
            {retryCount != null ? `Retry ${retryCount} failed` : `Export ${sel.size} to Notion`}
          </button>
        </>
      )}
      {summary.decisions.length > 0 && (
        <>
          <h2 style={sec}>Decisions</h2>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {summary.decisions.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </>
      )}
      {summary.usefulInfo.length > 0 && (
        <>
          <h2 style={sec}>Useful info</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {summary.usefulInfo.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
