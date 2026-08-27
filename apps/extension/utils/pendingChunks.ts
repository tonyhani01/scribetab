/** Ephemeral in-flight transcription rows for the live side panel. In-memory only. */

export interface PendingChunk {
  chunkIndex: number;
  startMs: number;
  durationMs: number;
  startedAt: number;
}

export function addPending(
  pending: readonly PendingChunk[],
  chunk: PendingChunk,
): PendingChunk[] {
  const next = pending.filter((p) => p.chunkIndex !== chunk.chunkIndex);
  next.push(chunk);
  next.sort((a, b) => a.chunkIndex - b.chunkIndex);
  return next;
}

/** Drop the resolved index and any earlier FIFO entries that must already be done. */
export function resolvePending(
  pending: readonly PendingChunk[],
  chunkIndex: number,
): PendingChunk[] {
  return pending.filter((p) => p.chunkIndex > chunkIndex);
}

/** Drop entries already covered by transcribedCount (including silent chunks). */
export function resolveBelow(
  pending: readonly PendingChunk[],
  count: number,
): PendingChunk[] {
  return pending.filter((p) => p.chunkIndex >= count);
}

export function clearPending(): PendingChunk[] {
  return [];
}
