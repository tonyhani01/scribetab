import type { MeetingSession } from '@scribetab/shared';

export function platformFromUrl(url: string | undefined): MeetingSession['platform'] {
  if (!url) return 'other';
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host === 'meet.google.com' || host.endsWith('.meet.google.com')) return 'meet';
  if (host === 'teams.microsoft.com' || host.endsWith('.teams.microsoft.com') || host === 'teams.live.com') {
    return 'teams';
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us') || host === 'zoom.com' || host.endsWith('.zoom.com')) {
    return 'zoom';
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  return 'other';
}

export function titleFromTab(tab: { title?: string } | undefined): string {
  const t = tab?.title?.trim();
  return t && t.length > 0 ? t : 'Untitled meeting';
}
