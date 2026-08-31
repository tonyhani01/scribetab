import { useRef, useState } from 'preact/hooks';
import type { ChatAskAck, ToBackground } from '@/utils/messages';
import { humanError } from '@/utils/userError';

/** Preset questions — one click, phrased for the shared transcript-chat prompt. */
const CHAT_CHIPS: ReadonlyArray<{ label: string; question: string }> = [
  { label: 'Catch me up', question: 'Catch me up: briefly summarize what has happened so far.' },
  { label: 'What was decided?', question: 'What was decided in this meeting?' },
  { label: 'Open questions', question: 'What questions were raised but left unanswered?' },
  {
    label: 'Draft a follow-up email',
    question: 'Draft a short follow-up email covering the key points, decisions, and next steps.',
  },
];

/**
 * Q&A over one session's transcript (live or completed). History lives only in
 * component state — mount keyed by session id, nothing is ever persisted.
 */
export function ChatView({ sessionId }: { sessionId: string }) {
  const [history, setHistory] = useState<{ q: string; a: string }[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef(history);
  historyRef.current = history;

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || pendingQ !== null) return;
    setError(null);
    setPendingQ(q);
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'background',
        type: 'CHAT_ASK',
        sessionId,
        question: q,
        history: historyRef.current,
      } satisfies ToBackground)) as ChatAskAck;
      if (res?.ok && typeof res.answer === 'string') {
        const answer = res.answer;
        setHistory((prev) => [...prev, { q, a: answer }]);
        setDraft('');
      } else if (res?.error === 'needs-permission') {
        setError('Grant the LLM provider host permission (see the summary section) to ask questions.');
      } else {
        setError(res?.error ?? humanError('Ask failed'));
      }
    } catch (e) {
      setError(humanError(e));
    } finally {
      setPendingQ(null);
    }
  };

  return (
    <section class="st-chat" aria-label="Ask the transcript">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {CHAT_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            class="st-chip"
            disabled={pendingQ !== null}
            onClick={() => void ask(chip.question)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {history.length === 0 && pendingQ === null && (
        <p data-testid="chat-empty" class="st-empty">
          Ask anything about this meeting — answers come from the transcript only.
        </p>
      )}
      <ol class="st-chat-turns" style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {history.map((turn, i) => (
          <li key={i} class="st-chat-turn">
            <p class="st-chat-q" style={{ fontWeight: 600, fontSize: 13, margin: '0 0 3px' }}>{turn.q}</p>
            <p class="st-chat-a" style={{ whiteSpace: 'pre-wrap', fontSize: 13, margin: 0, background: 'var(--st-tint)', borderRadius: 6, padding: '6px 8px' }}>{turn.a}</p>
          </li>
        ))}
        {pendingQ !== null && (
          <li class="st-chat-turn">
            <p class="st-chat-q" style={{ fontWeight: 600, fontSize: 13, margin: '0 0 3px' }}>{pendingQ}</p>
            <p class="st-hint st-gen" aria-live="polite" style={{ margin: 0 }}>
              <span class="st-gen-dot" />
              <span>Thinking…</span>
            </p>
          </li>
        )}
      </ol>
      {error && <p data-testid="chat-error" class="st-banner st-banner--error">{error}</p>}
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        <input
          type="text"
          class="st-input"
          style={{ flex: 1, maxWidth: 'none' }}
          placeholder="Ask about this meeting…"
          value={draft}
          disabled={pendingQ !== null}
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        />
        <button type="submit" class="st-btn" disabled={pendingQ !== null || !draft.trim()}>
          Ask
        </button>
      </form>
    </section>
  );
}
