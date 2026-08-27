export type SummaryDeltaPhase = 'summary' | 'actions';

export interface SummaryLiveState {
  runId: string | null;
  phases: { summary?: string; actions?: string };
}

export const EMPTY_SUMMARY_LIVE: SummaryLiveState = { runId: null, phases: {} };

/** Latest generation wins: a different runId replaces live texts. */
export function applySummaryDelta(
  state: SummaryLiveState,
  delta: { runId: string; phase: SummaryDeltaPhase; text: string },
): SummaryLiveState {
  if (state.runId !== delta.runId) {
    return { runId: delta.runId, phases: { [delta.phase]: delta.text } };
  }
  return {
    runId: state.runId,
    phases: { ...state.phases, [delta.phase]: delta.text },
  };
}

export function summaryLiveText(state: SummaryLiveState): string {
  const { summary, actions } = state.phases;
  if (summary && actions) return `${summary}\n${actions}`;
  return summary ?? actions ?? '';
}

export function summaryLivePhase(state: SummaryLiveState): SummaryDeltaPhase | null {
  if (state.phases.actions !== undefined) return 'actions';
  if (state.phases.summary !== undefined) return 'summary';
  return null;
}
