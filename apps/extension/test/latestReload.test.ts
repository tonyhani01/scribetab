import { describe, expect, it, vi } from 'vitest';
import { LatestReloadCoordinator } from '../utils/latestReload';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('latest reload coordination', () => {
  it('does not sync or apply an older list after a newer reload starts', async () => {
    const coordinator = new LatestReloadCoordinator();
    const oldList = deferred<string[]>();
    const newList = deferred<string[]>();
    const sync = vi.fn(async (list: string[]) => list);
    const applied: string[][] = [];

    const reload = async (listPromise: Promise<string[]>) => {
      const generation = coordinator.begin();
      const list = await listPromise;
      if (!coordinator.isCurrent(generation)) return false;
      await sync(list);
      if (!coordinator.isCurrent(generation)) return false;
      applied.push(list);
      return true;
    };

    const oldRun = reload(oldList.promise);
    const newRun = reload(newList.promise);
    newList.resolve(['new-session']);
    await expect(newRun).resolves.toBe(true);
    oldList.resolve(['deleted-session']);
    await expect(oldRun).resolves.toBe(false);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(['new-session']);
    expect(applied).toEqual([['new-session']]);
  });

  it('invalidates an in-flight reload when a newer delete/add refresh begins', () => {
    const coordinator = new LatestReloadCoordinator();
    const first = coordinator.begin();
    expect(coordinator.isCurrent(first)).toBe(true);
    const second = coordinator.begin();
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });
});
