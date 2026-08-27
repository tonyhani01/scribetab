import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_LIVE,
  applySummaryDelta,
  summaryLivePhase,
  summaryLiveText,
} from '../utils/summaryLive';

describe('applySummaryDelta', () => {
  it('locks onto the first runId of the current generation view', () => {
    const s = applySummaryDelta(EMPTY_SUMMARY_LIVE, {
      runId: 'run-a',
      phase: 'summary',
      text: 'Hel',
    });
    expect(s).toEqual({ runId: 'run-a', phases: { summary: 'Hel' } });
    expect(summaryLivePhase(s)).toBe('summary');
  });

  it('composes actions under the streamed summary instead of replacing it', () => {
    let s = applySummaryDelta(EMPTY_SUMMARY_LIVE, {
      runId: 'run-a',
      phase: 'summary',
      text: 'Ship Friday.',
    });
    s = applySummaryDelta(s, { runId: 'run-a', phase: 'actions', text: '- Ada ships' });
    expect(s.phases).toEqual({ summary: 'Ship Friday.', actions: '- Ada ships' });
    expect(summaryLiveText(s)).toBe('Ship Friday.\n- Ada ships');
    expect(summaryLivePhase(s)).toBe('actions');
  });

  it('resets live texts when a later generation runId arrives', () => {
    let s = applySummaryDelta(EMPTY_SUMMARY_LIVE, {
      runId: 'run-a',
      phase: 'summary',
      text: 'Old summary',
    });
    s = applySummaryDelta(s, { runId: 'run-a', phase: 'actions', text: '- old' });
    s = applySummaryDelta(s, { runId: 'run-b', phase: 'summary', text: 'New summary' });
    expect(s).toEqual({ runId: 'run-b', phases: { summary: 'New summary' } });
    expect(summaryLiveText(s)).toBe('New summary');
  });
});
