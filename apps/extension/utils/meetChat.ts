export interface MeetChatSnapshot {
  author: string;
  text: string;
}

export interface MeetChatState {
  snapshots: MeetChatSnapshot[];
}

export const EMPTY_MEET_CHAT_STATE: MeetChatState = { snapshots: [] };

/**
 * Google Meet's chat DOM is private and fragile. Keep every selector here so a
 * Meet restyle has one best-effort repair point and missing nodes stay a no-op.
 */
export const MEET_CHAT_SELECTORS = {
  messageGroup: '[aria-live="polite"]',
  container: ['[data-meeting-chat]', '.z38b6'],
  messageScope: ['[data-sender-name]', '[data-author-name]', '.GDhqjd'],
  author: ['[data-sender-name]', '[data-author-name]', '.poVWob'],
  text: ['[data-message-text]', '.beTDc'],
} as const;

function normalizeMeetChatSnapshot(snapshot: MeetChatSnapshot): MeetChatSnapshot | null {
  const author = snapshot.author.replace(/\s+/g, ' ').trim();
  const text = snapshot.text.replace(/\s+/g, ' ').trim();
  return author && text ? { author, text } : null;
}

function sameSnapshot(a: MeetChatSnapshot, b: MeetChatSnapshot): boolean {
  return a.author === b.author && a.text === b.text;
}

export function applyMeetChatSnapshots(
  state: MeetChatState,
  snapshots: MeetChatSnapshot[],
): { state: MeetChatState; events: MeetChatSnapshot[] } {
  const next = snapshots
    .map(normalizeMeetChatSnapshot)
    .filter((snapshot): snapshot is MeetChatSnapshot => snapshot !== null);
  if (next.length === 0) return { state, events: [] };

  // Meet may trim old rows or prepend hydrated history. Find the longest old
  // suffix anywhere in the new list; only ordered rows after it are new cues.
  let matchedAt = -1;
  let matchedLength = Math.min(state.snapshots.length, next.length);
  findOverlap: while (matchedLength > 0) {
    const previousOffset = state.snapshots.length - matchedLength;
    for (let start = 0; start + matchedLength <= next.length; start++) {
      const matches = next
        .slice(start, start + matchedLength)
        .every((snapshot, index) =>
          sameSnapshot(state.snapshots[previousOffset + index]!, snapshot));
      if (matches) {
        matchedAt = start;
        break findOverlap;
      }
    }
    matchedLength--;
  }

  return {
    state: { snapshots: next },
    events: next.slice(matchedAt < 0 ? 0 : matchedAt + matchedLength),
  };
}

function queryFirst(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

function normalizedText(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function messageScope(group: Element): Element {
  return group.closest(MEET_CHAT_SELECTORS.messageScope.join(', '))
    ?? group.parentElement
    ?? group;
}

function readAuthor(group: Element): string {
  const scope = messageScope(group);
  const authorElement = queryFirst(scope, MEET_CHAT_SELECTORS.author);
  return (
    scope.getAttribute('data-sender-name')
    ?? scope.getAttribute('data-author-name')
    ?? authorElement?.getAttribute('data-sender-name')
    ?? authorElement?.getAttribute('data-author-name')
    ?? normalizedText(authorElement)
  ).replace(/\s+/g, ' ').trim();
}

/** The currently mounted chat list, or null when the user has not opened it. */
export function findMeetChatContainer(root: ParentNode): Element | null {
  for (const group of root.querySelectorAll(MEET_CHAT_SELECTORS.messageGroup)) {
    // Other Meet features also use polite live regions; a chat author is the
    // discriminator that keeps captions and status announcements out.
    if (!readAuthor(group)) continue;
    for (const selector of MEET_CHAT_SELECTORS.container) {
      const container = group.closest(selector);
      if (container) return container;
    }
    return group.parentElement;
  }
  return null;
}

/** Read ordered author/text snapshots without throwing when Meet's DOM drifts. */
export function parseMeetChatSnapshots(root: ParentNode): MeetChatSnapshot[] {
  const snapshots: MeetChatSnapshot[] = [];
  for (const group of root.querySelectorAll(MEET_CHAT_SELECTORS.messageGroup)) {
    const scope = messageScope(group);
    const author = readAuthor(group);
    if (!author) continue;

    const textElement = queryFirst(group, MEET_CHAT_SELECTORS.text)
      ?? queryFirst(scope, MEET_CHAT_SELECTORS.text);
    const rawText = normalizedText(textElement) || normalizedText(group);
    const snapshot = normalizeMeetChatSnapshot({ author, text: rawText });
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}
