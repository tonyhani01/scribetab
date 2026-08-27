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
  key: string;
  speaker: string;
  text: string;
  startMs: number;
  lastChangeMs: number;
  emitted: boolean;
  /** Character length of `text` already emitted (prefix). Continuation emits only the suffix. */
  emittedLength: number;
}

export interface CaptionReduceState {
  blocks: OpenCaption[];
}

export const EMPTY_CAPTION_STATE: CaptionReduceState = { blocks: [] };

export function normalizeSnapshot(s: CaptionSnapshot): CaptionSnapshot {
  return {
    speaker: s.speaker.replace(/\s+/g, ' ').trim(),
    text: s.text.replace(/\s+/g, ' ').trim(),
  };
}

export function blockKey(speaker: string, position: number): string {
  return `${position}\0${speaker}`;
}

function cueEndMs(open: OpenCaption): number {
  return Math.max(open.lastChangeMs, open.startMs + 1);
}

function pendingText(open: OpenCaption): string {
  if (open.emittedLength <= 0) return open.text;
  return open.text.slice(open.emittedLength).replace(/^\s+/, '').trim();
}

function flushOpen(open: OpenCaption | null): CaptionEvent | null {
  if (!open || !open.text || open.emitted) return null;
  const text = pendingText(open);
  if (!text) return null;
  return {
    speaker: open.speaker,
    text,
    timestampMs: open.startMs,
    endMs: cueEndMs(open),
  };
}

function openBlock(snap: CaptionSnapshot, position: number, nowMs: number): OpenCaption {
  return {
    key: blockKey(snap.speaker, position),
    speaker: snap.speaker,
    text: snap.text,
    startMs: nowMs,
    lastChangeMs: nowMs,
    emitted: false,
    emittedLength: 0,
  };
}

function applyToBlock(open: OpenCaption, snap: CaptionSnapshot, nowMs: number): OpenCaption {
  if (open.text === snap.text) return open;

  if (!open.emitted) {
    return { ...open, text: snap.text, lastChangeMs: nowMs };
  }

  const emittedPrefix = open.text.slice(0, open.emittedLength);
  if (snap.text.startsWith(emittedPrefix) && snap.text.length >= open.emittedLength) {
    // Continued growth after a stabilize-emit: keep emittedLength, start a new interval for the suffix.
    return {
      ...open,
      text: snap.text,
      startMs: nowMs,
      lastChangeMs: nowMs,
      emitted: false,
    };
  }

  return {
    ...open,
    text: snap.text,
    startMs: nowMs,
    lastChangeMs: nowMs,
    emitted: false,
    emittedLength: 0,
  };
}

/**
 * Fold currently-visible caption snapshots into per-block in-progress captions.
 * Each snapshot index is a block (speaker+position). Speaker changes, disappearances,
 * and a final update batched with a new block are all applied in one pass.
 */
export function applyCaptionSnapshots(
  state: CaptionReduceState,
  snapshots: CaptionSnapshot[],
  nowMs: number,
): { state: CaptionReduceState; events: CaptionEvent[] } {
  const events: CaptionEvent[] = [];
  const remaining = [...state.blocks];
  const next: OpenCaption[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const snap = normalizeSnapshot(snapshots[i]!);
    if (!snap.text) continue;
    const idx = remaining.findIndex((b) => b.speaker === snap.speaker);
    if (idx >= 0) {
      const existing = remaining.splice(idx, 1)[0]!;
      next.push({ ...applyToBlock(existing, snap, nowMs), key: blockKey(snap.speaker, i) });
    } else {
      next.push(openBlock(snap, i, nowMs));
    }
  }

  for (const prev of remaining) {
    const ev = flushOpen(prev);
    if (ev) events.push(ev);
  }

  return { state: { blocks: next }, events };
}

/** Emit each open caption whose text has been unchanged for `idleMs`. */
export function stabilizeCaption(
  state: CaptionReduceState,
  nowMs: number,
  idleMs: number,
): { state: CaptionReduceState; events: CaptionEvent[] } {
  const events: CaptionEvent[] = [];
  const blocks = state.blocks.map((open) => {
    if (open.emitted || !open.text) return open;
    if (nowMs - open.lastChangeMs < idleMs) return open;
    const ev = flushOpen(open);
    if (!ev) return { ...open, emitted: true, emittedLength: open.text.length };
    events.push(ev);
    return { ...open, emitted: true, emittedLength: open.text.length };
  });
  return { state: { blocks }, events };
}
