import { describe, expect, it } from 'vitest';
import { PerSessionMutationQueue } from '../utils/sessionMutationQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('per-session mutation queue', () => {
  it('serializes mutations for one session in submission order', async () => {
    const queue = new PerSessionMutationQueue();
    const gate = deferred<void>();
    const events: string[] = [];

    const first = queue.run('s1', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = queue.run('s1', async () => {
      events.push('second');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('recovers after a rejected mutation and cleans up its session state', async () => {
    const queue = new PerSessionMutationQueue();
    await expect(queue.run('s1', async () => { throw new Error('failed'); })).rejects.toThrow('failed');

    const result = await queue.run('s1', async () => 'recovered');
    expect(result).toBe('recovered');
    expect(queue.size).toBe(0);
  });

  it('does not serialize unrelated sessions', async () => {
    const queue = new PerSessionMutationQueue();
    const gate = deferred<void>();
    const events: string[] = [];
    const first = queue.run('s1', async () => {
      events.push('s1:start');
      await gate.promise;
      events.push('s1:end');
    });
    const second = queue.run('s2', async () => {
      events.push('s2');
    });

    await second;
    expect(events).toEqual(['s1:start', 's2']);
    gate.resolve(undefined);
    await first;
  });
});
