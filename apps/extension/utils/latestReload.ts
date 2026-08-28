/** Coordinates refreshes so only the newest request may commit its result. */
export class LatestReloadCoordinator {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}
