import type { ActionItem, ExportActionsAck, ExportActionsMessage } from '@scribetab/shared';
import { NATIVE_HOST_NAME } from './nativeSync';
import { getSession, updateSession } from './sessionStore';

export const EXPORT_ACK_TIMEOUT_MS = 90_000;

export function nextSelection(
  prev: Set<string>,
  ack: ExportActionsAck,
): { sel: Set<string>; retryCount: number | null; transportError: string | null } {
  if (!ack.ok && ack.results.length === 0) {
    return {
      sel: prev,
      retryCount: null,
      transportError: ack.error ?? 'Export failed',
    };
  }
  const failed = ack.results.filter((r) => !r.ok);
  return {
    sel: new Set(failed.map((r) => r.id)),
    retryCount: failed.length === 0 ? null : failed.length,
    transportError: null,
  };
}

type NativePort = {
  postMessage: (msg: ExportActionsMessage) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: (msg: ExportActionsAck) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
};

function failAck(sessionId: string, error: string): ExportActionsAck {
  return { ok: false, sessionId, error, results: [] };
}

/**
 * Post one export_actions message on a short-lived connectNative port and
 * resolve on the first ack (same settle pattern as nativeSync.streamToPort,
 * minus audio/follow-up).
 */
export async function exportActionsViaHost(
  sessionId: string,
  items: ActionItem[],
  opts?: { ackTimeoutMs?: number },
): Promise<ExportActionsAck> {
  let port: NativePort;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME) as unknown as NativePort;
  } catch (e) {
    return failAck(sessionId, e instanceof Error ? e.message : String(e));
  }

  const ackTimeoutMs = opts?.ackTimeoutMs ?? EXPORT_ACK_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (ack: ExportActionsAck) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // already disconnected
      }
      resolve(ack);
    };

    port.onMessage.addListener((msg: ExportActionsAck) => {
      if (!msg || typeof msg !== 'object') {
        settle(failAck(sessionId, 'Invalid export ack'));
        return;
      }
      settle({
        ok: Boolean(msg.ok),
        sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : sessionId,
        results: Array.isArray(msg.results) ? msg.results : [],
        ...(typeof msg.error === 'string' ? { error: msg.error } : {}),
        ...(typeof msg.pageUrl === 'string' ? { pageUrl: msg.pageUrl } : {}),
      });
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? 'Native host disconnected';
      settle(failAck(sessionId, err));
    });

    timer = setTimeout(() => {
      settle(failAck(sessionId, `Host ack timed out after ${ackTimeoutMs}ms`));
    }, ackTimeoutMs);

    const message: ExportActionsMessage = {
      type: 'export_actions',
      protocolVersion: 1,
      sessionId,
      items,
    };
    try {
      port.postMessage(message);
    } catch (e) {
      settle(failAck(sessionId, e instanceof Error ? e.message : String(e)));
    }
  });
}

export async function exportSelectedActionItems(
  sessionId: string,
  itemIds: string[],
): Promise<ExportActionsAck> {
  const session = await getSession(sessionId);
  const all = session?.summary?.actionItems ?? [];
  const wanted = new Set(itemIds);
  const items = all.filter((i) => wanted.has(i.id));
  if (!session || items.length === 0) {
    return failAck(sessionId, 'No matching action items');
  }
  const ack = await exportActionsViaHost(sessionId, items);
  const okIds = ack.results.filter((r) => r.ok).map((r) => r.id);
  if (okIds.length) {
    const at = new Date().toISOString();
    const patch = { ...(session.actionExports ?? {}) };
    for (const id of okIds) patch[id] = { destination: 'notion' as const, at };
    await updateSession(sessionId, { actionExports: patch });
  }
  return ack;
}
