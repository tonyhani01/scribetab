import { describe, expect, it } from 'vitest';
import { canDeleteSession } from '../utils/librarySession';

describe('canDeleteSession', () => {
  it('allows deleting complete and failed sessions', () => {
    expect(canDeleteSession('complete')).toBe(true);
    expect(canDeleteSession('failed')).toBe(true);
  });

  it('refuses deleting a session that is still recording', () => {
    expect(canDeleteSession('recording')).toBe(false);
  });
});
