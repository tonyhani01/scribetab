type Mutation<T> = () => T | Promise<T>;

/**
 * Runs mutations for each session in submission order while allowing
 * unrelated sessions to proceed independently.
 */
export class PerSessionMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.tails.size;
  }

  run<T>(sessionId: string, mutation: Mutation<T>): Promise<T> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(mutation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    const cleanup = () => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    };
    // Register on the result as well as deriving the tail so callers that
    // await a completed mutation observe the queue already cleaned up.
    result.then(cleanup, cleanup);
    return result;
  }
}
