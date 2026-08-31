export type ReadyNotificationKind = 'transcript' | 'summary';

export function notifyReady(
  kind: ReadyNotificationKind,
  title: string,
  enabled: boolean,
): void {
  if (!enabled || typeof chrome === 'undefined') return;
  const notifications = chrome.notifications;
  if (typeof notifications?.create !== 'function') return;

  const message = kind === 'transcript'
    ? `ScribeTab — transcript ready: ${title}`
    : `Summary ready: ${title}`;
  try {
    const pending: unknown = notifications.create({
      type: 'basic',
      iconUrl: 'icon-128.png',
      title: 'ScribeTab',
      message,
    });
    if (pending && typeof (pending as Promise<string>).catch === 'function') {
      void (pending as Promise<string>).catch(() => {});
    }
  } catch {
    // Extension API unavailable in this context or shutting down.
  }
}
