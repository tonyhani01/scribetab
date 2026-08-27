export interface CaptionSnapshot {
  speaker: string;
  text: string;
}

export interface CaptionEvent {
  speaker: string;
  text: string;
  timestampMs: number;
  endMs: number;
}

export interface OpenCaption {
  speaker: string;
  text: string;
  startMs: number;
  lastChangeMs: number;
  emitted: boolean;
}

export interface CaptionReduceState {
  open: OpenCaption | null;
}

export const EMPTY_CAPTION_STATE: CaptionReduceState = { open: null };

export function normalizeSnapshot(s: CaptionSnapshot): CaptionSnapshot {
  return {
    speaker: s.speaker.replace(/\s+/g, ' ').trim(),
    text: s.text.replace(/\s+/g, ' ').trim(),
  };
}

function lastActive(snapshots: CaptionSnapshot[]): CaptionSnapshot | null {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = normalizeSnapshot(snapshots[i]!);
    if (s.text) return s;
  }
  return null;
}

function flushOpen(open: OpenCaption | null, nowMs: number): CaptionEvent | null {
  if (!open || !open.text || open.emitted) return null;
  return {
    speaker: open.speaker,
    text: open.text,
    timestampMs: open.startMs,
    endMs: Math.max(nowMs, open.startMs + 1),
  };
}

/**
 * Fold currently-visible caption snapshots into an in-progress caption.
 * Emits the previous caption when the speaker changes or captions disappear.
 * Partial in-place edits of the same speaker stay open until `stabilizeCaption`.
 */
export function applyCaptionSnapshots(
  state: CaptionReduceState,
  snapshots: CaptionSnapshot[],
  nowMs: number,
): { state: CaptionReduceState; events: CaptionEvent[] } {
  const events: CaptionEvent[] = [];
  const active = lastActive(snapshots);

  if (!active) {
    const flushed = flushOpen(state.open, nowMs);
    return { state: { open: null }, events: flushed ? [flushed] : [] };
  }

  let open = state.open;
  if (open && open.speaker !== active.speaker) {
    const ev = flushOpen(open, nowMs);
    if (ev) events.push(ev);
    open = null;
  }

  if (!open) {
    open = {
      speaker: active.speaker,
      text: active.text,
      startMs: nowMs,
      lastChangeMs: nowMs,
      emitted: false,
    };
  } else if (open.text !== active.text) {
    open = {
      speaker: open.speaker,
      text: active.text,
      startMs: open.emitted ? nowMs : open.startMs,
      lastChangeMs: nowMs,
      emitted: false,
    };
  }

  return { state: { open }, events };
}

/** Emit the open caption once its text has been unchanged for `idleMs`. */
export function stabilizeCaption(
  state: CaptionReduceState,
  nowMs: number,
  idleMs: number,
): { state: CaptionReduceState; events: CaptionEvent[] } {
  const open = state.open;
  if (!open || open.emitted || !open.text) return { state, events: [] };
  if (nowMs - open.lastChangeMs < idleMs) return { state, events: [] };
  const event: CaptionEvent = {
    speaker: open.speaker,
    text: open.text,
    timestampMs: open.startMs,
    endMs: Math.max(nowMs, open.startMs + 1),
  };
  return { state: { open: { ...open, emitted: true } }, events: [event] };
}
