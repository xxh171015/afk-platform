// How many items sit in the waiting queue: the nav badge and the workbench 等你处理 quadrant share this.

export function waitingCount(queue: {
  tickets: readonly unknown[];
  finalizations: readonly unknown[];
  pullRequests: readonly unknown[];
  cleanups: readonly unknown[];
  readyFailures: readonly unknown[];
  specs: readonly unknown[];
}): number {
  return (
    queue.tickets.length +
    queue.finalizations.length +
    queue.pullRequests.length +
    queue.cleanups.length +
    queue.readyFailures.length +
    queue.specs.length
  );
}
