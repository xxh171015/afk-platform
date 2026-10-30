// At most `max` integration environments at once on one worker (the project's maxIntegrationEnvironments): the
// next one waits, still holding its job, until a place is free. Places are given out in the order they were asked
// for.
export class EnvironmentLimiter {
  // The compose projects this worker has running or is starting: the ones its cleanup of leftovers must not touch.
  readonly projects = new Set<string>();
  private taken = 0;
  private readonly waiting: (() => void)[] = [];

  get active(): number {
    return this.taken;
  }

  // Resolves with the function that gives the place back. `max` is read at the time of asking: a project may
  // change it between two jobs.
  acquire(max: number, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.taken += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.taken -= 1;
          this.next(max);
        });
      };
      if (this.taken < max && this.waiting.length === 0) return grant();
      const turn = () => {
        signal?.removeEventListener("abort", giveUp);
        grant();
      };
      const giveUp = () => {
        const at = this.waiting.indexOf(turn);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new Error("the job was lost while waiting for an environment"));
      };
      this.waiting.push(turn);
      if (signal?.aborted) giveUp();
      else signal?.addEventListener("abort", giveUp, { once: true });
    });
  }

  private next(max: number) {
    while (this.taken < max) {
      const turn = this.waiting.shift();
      if (!turn) return;
      turn();
    }
  }
}
