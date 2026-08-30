import {
  actionItemLine,
  computeTalkTime,
  formatChapterStamp,
  type ExportActionsAck,
  type SessionSummary,
  type TalkTimeEntry,
} from '@scribetab/shared';
import { useEffect, useState } from 'preact/hooks';
import type { StoredSession } from '@/utils/sessionStore';
import { getSegments } from '@/utils/segmentStore';
import { nextSelection } from '@/utils/actionExport';

/**
 * Playback seek contract with the library audio player (task A1): the player
 * listens for `st-seek` on `window` and jumps to `detail.startMs` when the
 * `detail.sessionId` matches what it is playing. With no player mounted the
 * dispatch is a no-op, so chapter rows are always safe to click.
 */
export const SEEK_EVENT = 'st-seek';

export function requestSeek(sessionId: string, startMs: number): void {
  window.dispatchEvent(new CustomEvent(SEEK_EVENT, { detail: { sessionId, startMs } }));
}

/** Mid-tone hues that stay legible on both the light card and a dark panel. */
const TALK_COLORS = ['#8b7cf6', '#2f9e68', '#e5484d', '#d8b64a', '#3f8efc', '#c2419f'] as const;

function TalkTimeBar({ rows }: { rows: TalkTimeEntry[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="st-talktime">
      <div
        class="st-talktime-bar"
        aria-hidden="true"
        style={{
          display: 'flex',
          height: 10,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'var(--st-track)',
          marginBottom: 6,
        }}
      >
        {rows.map((r, i) => {
          // flex-grow on raw ms keeps the bar proportional even though pct is rounded.
          return (
            <div
              key={r.speaker}
              class="st-talktime-seg"
              title={`${r.speaker} — ${r.pct}%`}
              style={{ flexGrow: r.ms, flexBasis: 0, background: TALK_COLORS[i % TALK_COLORS.length]! }}
            />
          );
        })}
      </div>
      <ul
        class="st-talktime-legend"
        style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 12 }}
      >
        {rows.map((r, i) => (
          <li key={r.speaker} class="st-talktime-item" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              class="st-talktime-dot"
              style={{ width: 8, height: 8, borderRadius: 999, flexShrink: 0, background: TALK_COLORS[i % TALK_COLORS.length]! }}
            />
            <span>{r.speaker}</span>
            <span style={{ color: 'var(--st-muted)', fontVariantNumeric: 'tabular-nums' }}>{r.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const [talkTime, setTalkTime] = useState<TalkTimeEntry[]>([]);

  useEffect(() => {
    setSel(new Set(summary.actionItems.filter((a) => !exports[a.id]).map((a) => a.id)));
    setLastResults({});
    setRetryCount(null);
  }, [sessionId, summary.generatedAt]);

  // Talk time is derived from the transcript, not the summary, so it is read
  // independently and simply hidden when the segment store is unavailable.
  useEffect(() => {
    let current = true;
    setTalkTime([]);
    getSegments(sessionId)
      .then((segments) => {
        if (current) setTalkTime(computeTalkTime(segments));
      })
      .catch(() => {
        if (current) setTalkTime([]);
      });
    return () => {
      current = false;
    };
  }, [sessionId]);

  const sec = { fontSize: 13, margin: '0 0 4px', fontWeight: 600 };
  // Storage written by an older build may hold junk rows — keep the same
  // tolerance the summary parser has.
  const chapters = (summary.chapters ?? []).filter(
    (c) => typeof c?.title === 'string' && c.title.trim() !== '' && Number.isFinite(c?.startMs),
  );
  return (
    <div style={{ background: '#f6f6f6', padding: 8, fontSize: 13, marginBottom: 12 }}>
      {summary.degraded && (
        <p style={{ color: '#a60', fontSize: 12, margin: '0 0 6px' }}>
          Structured extraction failed — showing plain summary.
        </p>
      )}
      {summary.narrative && <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>{summary.narrative}</p>}
      {chapters.length > 0 && (
        <>
          <h2 style={sec}>Chapters</h2>
          <ol class="st-chapters" style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
            {chapters.map((c) => (
              <li key={`${c.startMs}-${c.title}`} class="st-chapter">
                <button
                  type="button"
                  class="st-chapter-btn"
                  onClick={() => requestSeek(sessionId, c.startMs)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    width: '100%',
                    background: 'transparent',
                    border: 0,
                    padding: '2px 0',
                    font: 'inherit',
                    color: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    class="st-chapter-time"
                    style={{ color: 'var(--st-accent-deep)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatChapterStamp(c.startMs)}
                  </span>
                  <span class="st-chapter-title">{c.title.trim()}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
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
      {talkTime.length > 0 && (
        <>
          <h2 style={{ ...sec, marginTop: 8 }}>Talk time</h2>
          <TalkTimeBar rows={talkTime} />
        </>
      )}
    </div>
  );
}
