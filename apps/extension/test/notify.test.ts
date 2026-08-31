import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyReady } from '../utils/notify';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notifyReady', () => {
  it('does nothing when ready notifications are disabled', () => {
    const create = vi.fn().mockResolvedValue('notification-id');
    vi.stubGlobal('chrome', { notifications: { create } });

    notifyReady('transcript', 'Weekly sync', false);

    expect(create).not.toHaveBeenCalled();
  });

  it('does not throw when the notifications API is unavailable', () => {
    vi.stubGlobal('chrome', {});

    expect(() => notifyReady('summary', 'Weekly sync', true)).not.toThrow();
  });

  it('creates the transcript-ready notification with the extension icon', () => {
    const create = vi.fn().mockResolvedValue('notification-id');
    vi.stubGlobal('chrome', { notifications: { create } });

    notifyReady('transcript', 'Weekly sync', true);

    expect(create).toHaveBeenCalledWith({
      type: 'basic',
      iconUrl: 'icon-128.png',
      title: 'ScribeTab',
      message: 'ScribeTab — transcript ready: Weekly sync',
    });
  });

  it('uses the summary-ready copy for completed summaries', () => {
    const create = vi.fn().mockResolvedValue('notification-id');
    vi.stubGlobal('chrome', { notifications: { create } });

    notifyReady('summary', 'Weekly sync', true);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Summary ready: Weekly sync',
    }));
  });
});
