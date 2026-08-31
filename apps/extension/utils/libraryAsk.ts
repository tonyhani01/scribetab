import type { SearchResult } from 'minisearch';
import {
  buildChatMessages,
  getLlmProvider,
  redactSegments,
  transcriptWithTimestamps,
  type ProviderConfig,
  type TranscriptSegment,
} from '@scribetab/shared';
import { llmConfigured, llmOriginGranted } from './intelligence';
import type { LibraryAskAck } from './messages';
import { personalContextPromptLine, type Settings } from './settings';
import { createIncrementalSearchCache } from './searchCache';
import { getSegments } from './segmentStore';
import { listSessions } from './sessionStore';
import { humanError } from './userError';

/**
 * Headroom under the shared 24k transcript clip: re-joining selected blocks
 * into one transcript adds a newline per block, so budgeting slightly below
 * SUMMARY_TRANSCRIPT_CHAR_LIMIT guarantees the shared clip never fires.
 */
export const LIBRARY_ASK_CHAR_BUDGET = 23_500;
/** How many top-scoring meetings an ask may draw from. */
export const LIBRARY_ASK_MAX_SESSIONS = 8;
/** Segments flanking each search match that ride along as reading context. */
export const LIBRARY_ASK_NEIGHBOR_RADIUS = 2;

/** One meeting's selected context: matched segments plus their neighbors. */
export interface LibraryAskHit {
  sessionId: string;
  segments: TranscriptSegment[];
  title: string;
  /** Epoch ms (from the session's ISO startedAt) for the block header date. */
  startedAt: number;
}

/** One session's search matches, collapsed out of MiniSearch results. */
export interface MatchedSession {
  sessionId: string;
  /** Segment ids the search matched within this session. */
  matchedIds: Set<string>;
}

// Same incremental corpus pattern as the panel's library search, but owned by
// the worker so a LIBRARY_ASK never re-reads every transcript.
const librarySearchCache = createIncrementalSearchCache(getSegments);

/**
 * Collapse MiniSearch results (already score-ordered) into per-session match
 * sets, ordered by each session's best score and capped at maxSessions.
 */
export function topMatchedSessions(
  results: readonly SearchResult[],
  maxSessions: number,
): MatchedSession[] {
  const order: string[] = [];
  const bySession = new Map<string, { score: number; matchedIds: Set<string> }>();
  for (const result of results) {
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId : '';
    const segmentId = typeof result.id === 'string' ? result.id : '';
    if (!sessionId || !segmentId) continue;
    const score = typeof result.score === 'number' ? result.score : 0;
    const entry = bySession.get(sessionId);
    if (entry) {
      if (score > entry.score) entry.score = score;
      entry.matchedIds.add(segmentId);
    } else {
      order.push(sessionId);
      bySession.set(sessionId, { score, matchedIds: new Set([segmentId]) });
    }
  }
  // Results arrive score-sorted; the sort is belt-and-braces for best-score
  // ordering and stable for ties.
  return order
    .map((sessionId) => ({ sessionId, entry: bySession.get(sessionId)! }))
    .sort((a, b) => b.entry.score - a.entry.score)
    .slice(0, Math.max(0, maxSessions))
    .map(({ sessionId, entry }) => ({ sessionId, matchedIds: entry.matchedIds }));
}

/**
 * Each matched segment plus up to `radius` neighbors on both sides, deduped
 * and in transcript order. Matched ids missing from `all` (deleted between
 * indexing and reading) are ignored.
 */
export function neighborSegments(
  all: readonly TranscriptSegment[],
  matchedIds: ReadonlySet<string>,
  radius = LIBRARY_ASK_NEIGHBOR_RADIUS,
): TranscriptSegment[] {
  const sorted = [...all].sort((a, b) => a.startMs - b.startMs);
  const indexById = new Map(sorted.map((segment, index) => [segment.id, index]));
  const keep = new Set<number>();
  for (const id of matchedIds) {
    const at = indexById.get(id);
    if (at === undefined) continue;
    for (let j = Math.max(0, at - radius); j <= Math.min(sorted.length - 1, at + radius); j++) {
      keep.add(j);
    }
  }
  return [...keep].sort((a, b) => a - b).map((index) => sorted[index]!);
}

/** Locale-independent `YYYY-MM-DD` from epoch ms; '' when the date is unusable. */
function formatBlockDate(startedAt: number): string {
  if (!Number.isFinite(startedAt)) return '';
  const d = new Date(startedAt);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function blockHeader(title: string, sessionNumber: number, startedAt: number): string {
  const safeTitle = title.trim() || 'Untitled meeting';
  const date = formatBlockDate(startedAt);
  return date
    ? `## ${safeTitle} (${date}) [session ${sessionNumber}]`
    : `## ${safeTitle} [session ${sessionNumber}]`;
}

/**
 * Turn score-ordered hits into prompt blocks headed `## <title> (<date>)
 * [session <n>]`, where `<n>` follows the input (search-score) order. Hits are
 * included greedily while the block fits `budgetChars`; at the first block
 * that does not fit, lower-scored meetings are dropped whole — except when
 * nothing fits at all, the top-scored body is trimmed to the remaining budget
 * so an ask always yields at least one block. Total output stays ≤ budget.
 */
export function selectContext(
  hits: readonly LibraryAskHit[],
  budgetChars: number,
): { header: string; body: string }[] {
  const budget = Math.max(0, Math.floor(budgetChars));
  const blocks: { header: string; body: string }[] = [];
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const header = blockHeader(hit.title, i + 1, hit.startedAt);
    const body = transcriptWithTimestamps(hit.segments);
    const cost = header.length + 1 + body.length;
    if (used + cost <= budget) {
      blocks.push({ header, body });
      used += cost;
      continue;
    }
    if (blocks.length === 0 && budget > header.length + 1) {
      blocks.push({ header, body: body.slice(0, budget - header.length - 1) });
    }
    break;
  }
  return blocks;
}

/**
 * Map prompt blocks back onto TranscriptSegment[] so the shared
 * buildChatMessages can wrap them. NaN start/end are deliberate:
 * transcriptWithTimestamps emits segments without a usable startMs unstamped,
 * so block headers keep their `## <title>` form while body lines carry their
 * own session-relative `[mm:ss]` stamps. These segments never touch storage.
 * Precondition: blocks were produced from `hits`, so blocks[i] ↔ hits[i].
 */
export function blocksToTranscriptSegments(
  blocks: readonly { header: string; body: string }[],
  hits: readonly LibraryAskHit[],
): TranscriptSegment[] {
  return blocks.map((block, i) => ({
    id: `library-ask-block-${i}`,
    sessionId: hits[i]?.sessionId ?? 'library-ask',
    startMs: Number.NaN,
    endMs: Number.NaN,
    text: block.body ? `${block.header}\n${block.body}` : block.header,
    source: 'audio' as const,
  }));
}

async function gatherLibraryHits(question: string, settings: Settings): Promise<LibraryAskHit[]> {
  const sessions = (await listSessions()).filter((s) => s.archivedAt === undefined);
  await librarySearchCache.sync(sessions);
  const results = librarySearchCache.createIndex().search(question);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const hits: LibraryAskHit[] = [];
  for (const group of topMatchedSessions(results, LIBRARY_ASK_MAX_SESSIONS)) {
    const session = byId.get(group.sessionId);
    if (!session) continue;
    const picked = neighborSegments(await getSegments(group.sessionId), group.matchedIds);
    if (picked.length === 0) continue;
    // Same policy as answerTranscriptQuestion: redact-at-rest rows are clean
    // on disk; otherwise redact just before the LLM sees the text.
    const segments = settings.redactAtRest
      ? picked
      : redactSegments(picked, { extraTerms: settings.redactTerms });
    hits.push({
      sessionId: session.id,
      title: session.title,
      startedAt: Date.parse(session.startedAt),
      segments,
    });
  }
  return hits;
}

/**
 * Q&A across the whole library: search all meetings with the question, build
 * budgeted context blocks from the top matches, and answer through the same
 * provider/permission/redaction plumbing as the per-session chat. The answer
 * is returned, never persisted; no per-session cost is attributed because a
 * library ask spans meetings.
 */
export async function answerLibraryQuestion(
  question: string,
  settings: Settings,
): Promise<LibraryAskAck> {
  if (!llmConfigured(settings)) return { ok: false, error: 'No LLM configured' };
  if (!(await llmOriginGranted(settings))) return { ok: false, error: 'needs-permission' };
  const q = question.trim();
  if (!q) return { ok: false, error: 'Question cannot be empty' };

  const hits = await gatherLibraryHits(q, settings);
  const blocks = selectContext(hits, LIBRARY_ASK_CHAR_BUDGET);
  if (blocks.length === 0) {
    return { ok: false, error: 'No matching meetings — try different words.' };
  }
  // selectContext keeps a prefix of the score-ordered hits, so the sources
  // list is exactly the slice that made it into the prompt.
  const sources = hits
    .slice(0, blocks.length)
    .map((hit) => ({ sessionId: hit.sessionId, title: hit.title }));
  const provider = getLlmProvider(settings.llmProviderId);
  const cfg: ProviderConfig = {
    apiKey: settings.llmApiKey,
    baseUrl: settings.llmProviderId === 'custom' ? settings.llmBaseUrl.trim() || undefined : undefined,
    model: settings.llmModel.trim() || undefined,
  };
  const messages = buildChatMessages({
    segments: blocksToTranscriptSegments(blocks, hits),
    question: q,
    personalContext: personalContextPromptLine(settings),
    // The compiled transcript spans meetings; each block's `## <title>`
    // header is what the model cites from.
    citeLabel: 'meeting title',
  });
  try {
    const answer = await provider.complete(messages, cfg);
    return { ok: true, answer, sources };
  } catch (e) {
    return { ok: false, error: humanError(e) };
  }
}
