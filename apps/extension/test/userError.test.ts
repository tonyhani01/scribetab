import { describe, expect, it } from 'vitest';
import { GENERIC_USER_ERROR, humanError, normalizeError } from '../utils/userError';

describe('humanError', () => {
  it('maps known capture failures', () => {
    expect(humanError(new Error('No active tab'))).toBe('No active tab to record.');
    expect(humanError('Error: Already recording')).toBe('Already recording this tab.');
    expect(humanError('tabCapture.getMediaStreamId failed')).toBe('This page cannot be recorded.');
  });

  it('never returns a stack or the raw exception', () => {
    const err = new Error('weird boom\n    at foo (bar.ts:1:1)');
    expect(humanError(err)).toBe(GENERIC_USER_ERROR);
    expect(humanError(err)).not.toMatch(/boom|bar\.ts/);
  });

  it('strips Error: prefixes when normalizing', () => {
    expect(normalizeError(new Error('No active tab'))).toBe('No active tab');
  });

  it('passes already-humanized messages through unchanged', () => {
    const msg = 'No active tab to record.';
    expect(humanError(msg)).toBe(msg);
    expect(humanError(GENERIC_USER_ERROR)).toBe(GENERIC_USER_ERROR);
    expect(humanError('Could not stop the recorder cleanly.')).toBe(
      'Could not stop the recorder cleanly.',
    );
  });

  it('does not claim captured audio was saved on stop failure', () => {
    expect(humanError(new Error('Stop failed'))).toBe('Could not stop the recorder cleanly.');
    expect(humanError(new Error('Stop failed'))).not.toMatch(/saved/i);
  });
});
