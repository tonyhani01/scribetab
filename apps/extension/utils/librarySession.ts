import type { MeetingSession } from '@scribetab/shared';

/** A session still recording must be stopped before it can be deleted. */
export function canDeleteSession(status: MeetingSession['status']): boolean {
  return status !== 'recording';
}
