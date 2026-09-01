import type { MeetingSession } from '@scribetab/shared';
import { platformFromUrl } from './platform';

/**
 * System labels are derived from session facts at finalize time — no settings,
 * no custom rules in v1, and nothing leaves the machine. The `title` input is
 * part of the shape so future rules can key off it without a breaking change.
 */
export interface AutoLabelInput {
  title: string;
  durationMs: number;
  speakerCount: number;
  url?: string;
}

/** URL-derived platform → label; at most one can ever match a single host. */
const PLATFORM_LABELS: Partial<Record<MeetingSession['platform'], string>> = {
  meet: 'Meet',
  zoom: 'Zoom',
  teams: 'Teams',
  youtube: 'YouTube',
};

const LONG_MS = 60 * 60 * 1_000; // "Long" means strictly over 60 minutes.

/**
 * Labels are returned in a fixed order (1:1, Long, then the URL label) so card
 * chips and the library filter row stay stable across re-renders.
 */
export function computeLabels(input: AutoLabelInput): string[] {
  const labels: string[] = [];
  if (input.speakerCount === 2) labels.push('1:1');
  if (input.durationMs > LONG_MS) labels.push('Long');
  const urlLabel = PLATFORM_LABELS[platformFromUrl(input.url)];
  if (urlLabel) labels.push(urlLabel);
  return labels;
}
